// Writes of a chat (docs/MCP.md §6, §7.1, §7.3): the permission marks are never changed; the write mode of the vault
// decides between "read only", a proposal sealed to the person, and a direct write. A direct write is a Yjs change of
// the latest snapshot, encrypted with the current vault key and put; a conflict is merged (CRDT) and put again, at most
// three times. Notes of protected projects are only ever proposed (version 1).
import * as Y from "yjs";
import { MockBridge, type BrowserVaultSnapshot } from "../../ui/src/bridge";
import { decryptSnapshot, encryptSnapshot, type Envelope } from "../../ui/src/browserauth";
import { signAsAgent } from "../../ui/src/agentcrypto";
import { MARKS_TEXT, permissionMarks, touchesPermissionMarks } from "../../ui/src/permissionmarks";
import { sealProposal, textHash, type ProposalOp } from "../../ui/src/proposals";
import { isSharedVaultId } from "../../ui/src/vaults";
import { AgentError, TEXT } from "./client";
import { noteText, within, type Session, type VaultView } from "./session";

export interface Change {
  op: ProposalOp; path: string; noteId: string;
  /** The note's text now ("" for a new note) and after the change (null: moved or trashed, text unchanged). */
  before: string; after: string | null;
  /** append/tasks: the text added at the end. */
  added?: string;
  to?: string;
  /** edit_note: refused, not merged, when the note changed on the server since the chat's copy. */
  strict?: boolean;
  /** set_task: the task line as the chat read it; refused, not merged, when the server's note no longer has it. */
  line?: string;
}
export interface Outcome { kind: "proposal" | "direct"; message: string; proposalId?: string }

export const WRITE_TEXT = {
  appendOnly: "W tej przestrzeni czat może tylko tworzyć notatki i dopisywać na końcu.",
  proposal: "Propozycja czeka na zatwierdzenie.",
  saved: "Zapisano.",
  retries: "Nie udało się zapisać po 3 próbach, bo notatki zmieniały się w tym czasie. Spróbuj jeszcze raz.",
  staleKey: "Klucz przestrzeni właśnie się zmienił. Spróbuj jeszcze raz.",
  stale: "Treść notatki zmieniła się od odczytu. Przeczytaj ją jeszcze raz (read_note) i podaj nowe expected.",
  taskStale: "Zadanie zmieniło się od odczytu. Odczytaj je ponownie.",
  staleKeyAt: (at: number) => `Klucz przestrzeni właśnie się zmienił. Nowe notatki można pobrać najwcześniej o ${new Date(at).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })}; spróbuj wtedy jeszcze raz.`,
  noKey: "Ten czat nie dostał nowego klucza tej przestrzeni, więc nie ma już do niej dostępu.",
  tooBig: "Propozycja jest za duża (najwyżej 1 MiB po zaszyfrowaniu). Podziel ją na mniejsze.",
};
const APPEND_OPS: ProposalOp[] = ["create", "append", "tasks"];
const NO_MARKS = permissionMarks("");
const MAX_TRIES = 3;

export type Route = "read-only" | "denied" | "proposal" | "direct";
/** Where a change goes, by the vault's write mode and role (most restrictive first). */
export function route(view: VaultView, change: Change): Route {
  if (view.writeMode === "none" || view.role === "viewer") return "read-only";
  const paths = [change.path, ...(change.to ? [change.to] : [])];
  if (view.writeMode === "proposals" || paths.some((p) => view.projects.some((x) => within(p, x.path)))) return "proposal";
  if (view.writeMode === "append" && !APPEND_OPS.includes(change.op)) return "denied";
  return "direct";
}

/** Refuses a change of the permission marks (§6): text changes compare the marks, moves and trash refuse notes that have any. */
export function checkMarks(change: Change): void {
  const touched = change.after === null ? permissionMarks(change.before) !== NO_MARKS : touchesPermissionMarks(change.before, change.after);
  if (touched) throw new AgentError(MARKS_TEXT, "other", 0);
}

const summaryOf = (c: Change): string => ({
  create: `Nowa notatka ${c.path}`, append: `Dopisanie do ${c.path}`, edit: `Zmiana ${c.path}`,
  move: `Przeniesienie ${c.path} do ${c.to}`, trash: `Do kosza: ${c.path}`, tasks: `Nowe zadania w ${c.path}`,
}[c.op]);

export async function applyChange(session: Session, view: VaultView, change: Change): Promise<Outcome> {
  checkMarks(change);
  const where = route(view, change);
  if (where === "read-only") throw new AgentError(TEXT.readOnly, "read-only", 0);
  if (where === "denied") throw new AgentError(WRITE_TEXT.appendOnly, "other", 0);
  if (where === "proposal") return propose(session, view, change);
  await writeDirect(session, view, change);
  return { kind: "direct", message: WRITE_TEXT.saved };
}

async function propose(session: Session, view: VaultView, c: Change): Promise<Outcome> {
  const text = c.op === "append" || c.op === "tasks" ? c.added : c.op === "create" || c.op === "edit" ? c.after ?? undefined : undefined;
  const summary = summaryOf(c);
  const body = {
    createdAt: Date.now(), summary,
    changes: [{ op: c.op, path: c.path, noteId: c.noteId, baseHash: c.op === "create" ? "" : await textHash(c.before), ...(text === undefined ? {} : { text }), ...(c.to ? { to: c.to } : {}) }],
  };
  const proposal = await sealProposal(body, { vaultId: view.id, agentId: session.keys.agentId, userId: view.person.userId, personBoxKey: view.person.boxKey, signSecret: session.keys.signSecret })
    .catch(() => { throw new AgentError(WRITE_TEXT.tooBig, "other", 0); });
  await session.client.request("POST", `/api/agent/vaults/${encodeURIComponent(view.id)}/proposals`, { proposal });
  session.proposals.push({ vaultId: view.id, path: c.to ?? c.path, proposalId: proposal.proposalId, summary });
  return { kind: "proposal", message: WRITE_TEXT.proposal, proposalId: proposal.proposalId };
}

// The text of a note set to `next` as one Yjs change: the common start and end stay, so concurrent edits elsewhere merge.
async function setText(bridge: MockBridge, id: string, next: string, appendOnly: boolean): Promise<void> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, await bridge.call<Uint8Array>("open_note", { id }));
  const vector = Y.encodeStateVector(doc);
  const text = doc.getText("content");
  const cur = text.toString();
  if (appendOnly) {
    if (!next.startsWith(cur)) throw new AgentError(TEXT.failed, "other", 0);
    text.insert(cur.length, next.slice(cur.length));
  } else {
    let a = 0;
    while (a < cur.length && a < next.length && cur[a] === next[a]) a++;
    let b = 0;
    while (b < cur.length - a && b < next.length - a && cur[cur.length - 1 - b] === next[next.length - 1 - b]) b++;
    doc.transact(() => { text.delete(a, cur.length - a - b); text.insert(a, next.slice(a, next.length - b)); });
  }
  await bridge.call("apply_update", { id, update: Y.encodeStateAsUpdate(doc, vector) });
  doc.destroy();
}

// The parts of a state the in-memory engine does not model (protected entries, marks, newer fields) are carried over
// from the server's state unchanged, and the vault header and reader fields stay the server's.
function carryOver(out: BrowserVaultSnapshot, remote: BrowserVaultSnapshot): BrowserVaultSnapshot {
  const state = out.state as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(remote.state)) if (!(k in state)) state[k] = v;
  out.state.me = remote.state.me;
  // the chat changes no member: the engine's own placeholder member (a personal vault) must not replace the person's name
  if (remote.state.organization && out.state.organization) Object.assign(out.state.organization, { me: remote.state.organization.me, members: remote.state.organization.members });
  out.vault = { ...remote.vault };
  return out;
}

async function writeDirect(session: Session, view: VaultView, c: Change): Promise<void> {
  if (!view.snapshot) throw new AgentError(TEXT.failed, "other", 0);
  const { userId } = view.person;
  const bridge = new MockBridge([]);
  bridge.setBrowserAccount(userId, "", isSharedVaultId(view.id) ? { id: view.id, name: view.name, kind: view.kind as "notatki" | "organizacja", ownerUserId: view.ownerUserId } : undefined);
  // task events the engine records for this change are signed by the chat (§6)
  bridge.eventSigner = async (event) => {
    const { signature: _s, ...rest } = event;
    Object.assign(event, await signAsAgent(rest, userId, session.keys.agentId, session.keys.signSecret));
  };
  let remote = view.snapshot;
  let revision = view.revision;
  bridge.mergeBrowserSnapshot(remote);
  if (c.op === "create") await setText(bridge, await bridge.call<string>("create_note", { path: c.path }), c.after ?? "", false);
  else if (c.op === "move") await bridge.call("rename", { id: c.noteId, path: c.to });
  else if (c.op === "trash") await bridge.call("delete", { id: c.noteId });
  else await setText(bridge, c.noteId, c.after ?? "", c.op !== "edit");
  await bridge.settleSignatures();

  let v = view;
  let key = v.keys.get(v.keyEpoch);
  if (!key) throw new AgentError(WRITE_TEXT.staleKey, "stale-key", 0);
  const path = `/api/agent/vaults/${encodeURIComponent(view.id)}/snapshot`;
  // a newer state from the server: strict changes are refused when their note (or task line) changed, others merge
  const takeRemote = async (snapshot: BrowserVaultSnapshot, rev: number) => {
    const now = snapshot.state.notes.find((n) => n.id === c.noteId);
    const text = now ? noteText(now.yjsUpdateBase64) : null;
    if (c.strict && text !== c.before) throw new AgentError(WRITE_TEXT.stale, "other", 409);
    if (c.line !== undefined && !(text?.split("\n").includes(c.line))) throw new AgentError(WRITE_TEXT.taskStale, "other", 409);
    remote = snapshot;
    revision = rev;
    bridge.mergeRemoteSnapshot(remote);
    await bridge.settleSignatures();
  };
  let rekeyed = false;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const out = carryOver(bridge.exportBrowserSnapshot(v.ownerUserId, v.id), remote);
    const envelope = await encryptSnapshot(out, key, v.keyEpoch);
    try {
      const answer = await session.client.request<{ revision: number }>("POST", path, { baseRevision: revision, envelope });
      if (!Number.isSafeInteger(answer.revision)) throw new AgentError(TEXT.failed, "other", 0);
      await session.setSnapshot(v, answer.revision, out);
      return;
    } catch (e) {
      if (!(e instanceof AgentError && (e.kind === "stale-key" || e.kind === "conflict"))) throw e;
      const theirs = e.kind === "conflict" ? e.body.envelope as Envelope | undefined : undefined;
      if (e.kind === "conflict" && (!theirs || typeof theirs !== "object" || !Number.isSafeInteger(e.body.revision))) throw new AgentError(TEXT.failed, "other", 409);
      if (e.kind === "stale-key" || !v.keys.get(theirs!.keyEpoch ?? v.keyEpoch)) {
        // a new key epoch: the new envelope from the vault's meta, the snapshot only when a full fetch is allowed (no 429)
        if (rekeyed) throw new AgentError(session.nextFullFetch(v.id) > Date.now() ? WRITE_TEXT.staleKeyAt(session.nextFullFetch(v.id)) : WRITE_TEXT.staleKey, "stale-key", 409);
        rekeyed = true;
        const fresh = await session.rekey(v.id);
        if (!fresh) throw new AgentError(WRITE_TEXT.noKey, "stale-key", 409);
        const fetched = fresh.revision !== v.revision;
        v = fresh;
        key = v.keys.get(v.keyEpoch)!;
        if (fetched && v.snapshot) await takeRemote(v.snapshot, v.revision);
        if (!theirs) { attempt--; continue; } // the put is tried again with the new key (a 409 conflict then brings the newest state)
      }
      const theirKey = v.keys.get(theirs!.keyEpoch ?? v.keyEpoch);
      if (!theirKey) throw new AgentError(WRITE_TEXT.noKey, "stale-key", 409);
      await takeRemote(await decryptSnapshot(theirs!, v.ownerUserId, v.id, theirKey), Number(e.body.revision));
    }
  }
  throw new AgentError(WRITE_TEXT.retries, "other", 409);
}
