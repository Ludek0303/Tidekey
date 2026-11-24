// @vitest-environment jsdom
// The sync socket's life (docs/WEB-WSPOLDZIELENIE.md "Połączenie"): keepalive pings, a silent socket given up, the
// backoff with jitter, and a reconnect that names its revision so the server need not send the whole vault again.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserBridge, reconnectDelay } from "./browserauth";

class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closed = false;
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor(readonly url: string) { FakeSocket.all.push(this); }
  open(): void { this.readyState = 1; this.onopen?.(); }
  receive(frame: unknown): void { this.onmessage?.({ data: JSON.stringify(frame) }); }
  send(data: string): void { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close(): void { this.closed = true; }
  types(): unknown[] { return this.sent.map((f) => f.type); }
}

type Driver = Record<string, any>;

const made: Driver[] = [];
// A BrowserBridge with only what the socket path touches; persisting and merging are stubbed.
function bridge(): Driver {
  const b = Object.create(BrowserBridge.prototype) as Driver;
  made.push(b);
  Object.assign(b, {
    info: { id: "v-1", ownerUserId: "owner" }, stopped: false, statusListeners: new Set(), syncState: "local",
    revision: 0, dirty: false, putsSent: 0, ackedPut: 0, remoteSeen: false, handling: 0, reconnects: 0, inflight: [],
    runMigration: async () => undefined, remoteMerged: vi.fn(async () => undefined), persist: vi.fn(async () => undefined),
  });
  return b;
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  // each bridge's online/visibility listeners would otherwise wake in the next test
  for (const b of made.splice(0)) { b.stopped = true; clearInterval(b.pingTimer); if (b.wake) { window.removeEventListener("online", b.wake); document.removeEventListener("visibilitychange", b.wake); } }
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe("reconnect delay", () => {
  it("doubles from 1 s to 30 s and adds under 1 s of jitter", () => {
    expect([1, 2, 3, 6, 10].map((n) => reconnectDelay(n, 0))).toEqual([1000, 2000, 4000, 30_000, 30_000]);
    expect(reconnectDelay(1, 0.999)).toBe(1999);
  });
});

describe("the sync socket", () => {
  it("names its revision and nonce in the hello only when every put was answered and nothing is unsent", () => {
    const b = bridge();
    b.startSync();
    FakeSocket.all[0].open();
    expect(FakeSocket.all[0].sent[0]).toEqual({ type: "hello", vaultId: "v-1" }); // a first open: the whole vault

    Object.assign(b, { remoteSeen: true, revision: 7, lastCanon: "s", serverState: "s", heldNonce: "n7" });
    b.dropSocket();
    vi.advanceTimersByTime(2000);
    FakeSocket.all[1].open();
    expect(FakeSocket.all[1].sent[0]).toEqual({ type: "hello", vaultId: "v-1", revision: 7, nonce: "n7" });

    // a put still waiting, unsent edits, a local state the server has not seen, or no known nonce: no revision
    for (const unsettled of [{ inflight: ["p2"] }, { dirty: true }, { lastCanon: "newer" }, { heldNonce: undefined }]) {
      Object.assign(b, { inflight: [], dirty: false, lastCanon: "s", heldNonce: "n7" }, unsettled);
      b.dropSocket();
      vi.advanceTimersByTime(40_000);
      const socket = FakeSocket.all.at(-1)!;
      socket.open();
      expect(socket.sent[0]).toEqual({ type: "hello", vaultId: "v-1" });
    }
  });

  it("a put refused with slow-down is sent again and blocks a resume until then", async () => {
    const b = bridge();
    Object.assign(b, { remoteSeen: true, revision: 3, lastCanon: "x", serverState: "x", heldNonce: "n3", inflight: ["px"], schedulePersist: vi.fn() });
    await b.handleMessage({ type: "error", code: "slow-down" });
    expect(b.inflight).toEqual([]);
    expect(b.serverState).toBeUndefined(); // the next persist compares against nothing, so X goes again
    expect(b.resumable()).toBeUndefined();
    expect(b.schedulePersist).toHaveBeenCalledWith("slow");
  });

  it("an unchanged snapshot for another revision is not trusted: the socket is dropped and no resume is offered", async () => {
    const b = bridge();
    b.startSync();
    FakeSocket.all[0].open();
    Object.assign(b, { revision: 5, heldNonce: "n5" });
    await b.handleMessage({ type: "snapshot", revision: 4, envelope: null, unchanged: true });
    expect([FakeSocket.all[0].closed, b.heldNonce, b.current]).toEqual([true, undefined, false]);
  });

  it("an unchanged snapshot sets synced without merging, and sends only what was written while away", async () => {
    const b = bridge();
    Object.assign(b, { revision: 7 });
    await b.handleMessage({ type: "snapshot", revision: 7, envelope: null, unchanged: true });
    expect([b.syncState, b.current, b.persist.mock.calls.length]).toEqual(["synced", true, 0]);
    expect(b.remoteMerged).toHaveBeenCalledOnce();
    b.dirty = true;
    await b.handleMessage({ type: "snapshot", revision: 7, envelope: null, unchanged: true });
    expect(b.persist).toHaveBeenCalledWith(true);
  });

  it("two puts on the wire: the first ack leaves the second waiting, so a reconnect does not resume", async () => {
    const b = bridge();
    Object.assign(b, { remoteSeen: true, revision: 3, lastCanon: "s2", serverState: "s2", heldNonce: "n3", setRole() {}, staleRetry: false,
      db: {}, user: { id: "u" } });
    b.socket = { readyState: 1, send() {} };
    b.sendPut({ nonce: "p1" }, "s1");
    b.sendPut({ nonce: "p2" }, "s2");
    vi.stubGlobal("indexedDB", undefined);
    b.inflight.shift(); b.heldNonce = "p1"; // what the ack handler does for the first put
    expect(b.resumable()).toBeUndefined();
    b.inflight.shift();
    expect(b.resumable()).toEqual({ revision: 3, nonce: "p1" });
  });

  it("pings every 25 s, and gives up a socket whose ping got no answer in 15 s", () => {
    const b = bridge();
    b.startSync();
    const first = FakeSocket.all[0];
    first.open();
    vi.advanceTimersByTime(25_000);
    expect(first.types()).toEqual(["hello", "ping"]);
    vi.advanceTimersByTime(1);
    first.receive({ type: "pong" });
    vi.advanceTimersByTime(25_000);
    expect(first.types()).toEqual(["hello", "ping", "ping"]);
    // no answer to that ping: the next check drops the socket, and one new socket follows after the backoff
    vi.advanceTimersByTime(25_000);
    expect(first.closed).toBe(true);
    expect(b.syncState).toBe("offline");
    vi.advanceTimersByTime(2000);
    expect(FakeSocket.all).toHaveLength(2);
    // the old socket's late close does not start another one
    first.onclose?.();
    vi.advanceTimersByTime(40_000);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("backs off while the server is down, and starts over after a snapshot", () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // no jitter: the waits are exactly 1 s, then 2 s
    const b = bridge();
    b.startSync();
    FakeSocket.all[0].onclose?.();
    vi.advanceTimersByTime(999);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1].onclose?.();
    vi.advanceTimersByTime(1999);
    expect(FakeSocket.all).toHaveLength(2); // the second wait is 2 s
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(3);
    FakeSocket.all[2].open();
    void b.handleMessage({ type: "snapshot", revision: 0, envelope: null, unchanged: true });
    expect(b.reconnects).toBe(0);
  });

  it("comes back at once when the browser is online again", () => {
    const b = bridge();
    b.startSync();
    FakeSocket.all[0].onclose?.();
    b.reconnects = 5; // a long backoff is running
    window.dispatchEvent(new Event("online"));
    expect(FakeSocket.all).toHaveLength(2);
  });
});

describe("a hidden tab", () => {
  it("whose timers ran late keeps a socket that answers, and drops one that does not", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const b = bridge();
    b.startSync();
    const socket = FakeSocket.all[0];
    socket.open();
    vi.setSystemTime(Date.now() + 5 * 60_000); // five minutes in a hidden tab, timers asleep
    document.dispatchEvent(new Event("visibilitychange"));
    expect(socket.types()).toEqual(["hello", "ping"]);
    vi.advanceTimersByTime(100);
    socket.receive({ type: "pong" });
    vi.advanceTimersByTime(16_100);
    expect(socket.closed).toBe(false);
    vi.setSystemTime(Date.now() + 5 * 60_000);
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(16_100); // the ping was not answered
    expect(socket.closed).toBe(true);
  });
});
