//! `notes-node` command line: `init`, `ticket`, `serve`, `health`, `files-check`, the account admin `users` / `delete-user` / `reset-password` / `signup-code(s)`, and the Claude chat switch `agents disable|enable|revoke-all`. Arguments are plain `--flag value` pairs.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::ExitCode;

use notes_node::run::{Options, start};
use notes_node::{admin, health, keys};

const USAGE: &str = "usage:
  notes-node init --data DIR [--public-addr IP:PORT] [--out FILE]
  notes-node ticket --data DIR [--public-addr IP:PORT] [--out FILE]
  notes-node serve --data DIR [--quic IP:PORT] [--http IP:PORT] [--web DIR]   (speech models: DIR/models)
                   [--max-spaces N] [--max-space-mb N] [--max-conns N] [--relay on|off]
                   [--admin-http IP:PORT]   (or NOTES_ADMIN_HTTP; needs NOTES_ADMIN_PASSWORD)
  notes-node health [--http IP:PORT]
  notes-node files-check --data DIR
  notes-node users --data DIR
  notes-node delete-user --data DIR --user EMAIL|ID [--confirm yes]
  notes-node reset-password --data DIR --user EMAIL|ID
  notes-node signup-code --data DIR [--label TEXT] [--days N]   (N: 1-90, default 7)
  notes-node signup-codes --data DIR
  notes-node agents disable|enable --data DIR
  notes-node agents revoke-all --data DIR [--confirm yes]";

/// `--name value` pairs after the command. Unknown names are an error.
struct Flags(Vec<(String, String)>);

impl Flags {
    fn parse(args: &[String], known: &[&str]) -> Result<Self, String> {
        let mut out = Vec::new();
        let mut it = args.iter();
        while let Some(name) = it.next() {
            let key = name
                .strip_prefix("--")
                .filter(|k| known.contains(k))
                .ok_or_else(|| format!("unknown option {name}"))?;
            let value = it.next().ok_or_else(|| format!("{name} needs a value"))?;
            out.push((key.to_string(), value.clone()));
        }
        Ok(Flags(out))
    }

    fn get(&self, name: &str) -> Option<&str> {
        self.0
            .iter()
            .rev()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    fn addr(&self, name: &str, default: &str) -> Result<SocketAddr, String> {
        let text = self.get(name).unwrap_or(default);
        text.parse()
            .map_err(|_| format!("--{name}: not an address: {text}"))
    }

    fn number<T: std::str::FromStr>(&self, name: &str, default: T) -> Result<T, String> {
        match self.get(name) {
            Some(text) => text
                .parse()
                .map_err(|_| format!("--{name}: not a number: {text}")),
            None => Ok(default),
        }
    }

    fn data(&self) -> Result<PathBuf, String> {
        self.get("data")
            .map(PathBuf::from)
            .ok_or_else(|| "--data is required".to_string())
    }

    fn public_addr(&self) -> Result<Option<SocketAddr>, String> {
        self.get("public-addr")
            .map(|t| {
                t.parse()
                    .map_err(|_| format!("--public-addr: not an address: {t}"))
            })
            .transpose()
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(code) => code,
        Err(message) => {
            eprintln!("notes-node: {message}\n{USAGE}");
            ExitCode::from(2)
        }
    }
}

fn run(args: &[String]) -> Result<ExitCode, String> {
    let Some((command, rest)) = args.split_first() else {
        return Err("no command".to_string());
    };
    match command.as_str() {
        "init" | "ticket" => {
            let flags = Flags::parse(rest, &["data", "public-addr", "out"])?;
            let data = flags.data()?;
            let public = flags.public_addr()?;
            if command == "init" {
                keys::init(&data).map_err(|e| e.to_string())?;
            }
            let ticket = keys::ticket(&data, public).map_err(|e| e.to_string())?;
            match flags.get("out") {
                Some(file) => keys::write_ticket(std::path::Path::new(file), &ticket)
                    .map_err(|e| e.to_string())?,
                None => println!("{ticket}"),
            }
            Ok(ExitCode::SUCCESS)
        }
        "serve" => {
            let flags = Flags::parse(
                rest,
                &[
                    "data",
                    "quic",
                    "http",
                    "web",
                    "max-spaces",
                    "max-space-mb",
                    "max-conns",
                    "relay",
                    "admin-http",
                ],
            )?;
            let opts = Options {
                data: flags.data()?,
                quic: flags.addr("quic", "0.0.0.0:7842")?,
                http: flags.addr("http", "0.0.0.0:8080")?,
                web: flags.get("web").map(PathBuf::from),
                max_spaces: flags.number("max-spaces", 100)?,
                max_space_mb: flags.number("max-space-mb", 1024)?,
                max_conns: flags.number("max-conns", 256)?,
                relay: match flags.get("relay").unwrap_or("off") {
                    "on" => true,
                    "off" => false,
                    other => return Err(format!("--relay: expected on or off, got {other}")),
                },
                admin_http: match flags.get("admin-http").map(str::to_string).or_else(|| std::env::var("NOTES_ADMIN_HTTP").ok().filter(|v| !v.is_empty())) {
                    Some(text) => Some(text.parse().map_err(|_| format!("--admin-http: not an address: {text}"))?),
                    None => None,
                },
            };
            serve(opts).map_err(|e| e.to_string())?;
            Ok(ExitCode::SUCCESS)
        }
        "health" => {
            let flags = Flags::parse(rest, &["http"])?;
            let addr = flags.addr("http", "127.0.0.1:8080")?;
            Ok(if health::check(addr) {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            })
        }
        "files-check" => {
            let data = Flags::parse(rest, &["data"])?.data()?;
            let summary = notes_node::run::files_check(&data)?;
            println!("notes-node files: reconcile {summary}");
            Ok(ExitCode::SUCCESS)
        }
        "users" => {
            let data = Flags::parse(rest, &["data"])?.data()?;
            for u in admin::list_users(&data)? {
                let vaults = u.vaults.iter().map(|(name, role)| format!("{name} ({role})")).collect::<Vec<_>>().join(", ");
                println!("{}  {:<32} {:<24} sesje: {:<3} {}  [{}]", day(u.created_at), u.email, u.name, u.sessions, u.id, vaults);
            }
            Ok(ExitCode::SUCCESS)
        }
        "delete-user" => {
            let flags = Flags::parse(rest, &["data", "user", "confirm"])?;
            let who = flags.get("user").ok_or("--user is required")?;
            let apply = flags.get("confirm") == Some("yes");
            let d = match admin::delete_user(&flags.data()?, who, apply) {
                Ok(d) => d,
                Err(refused) => { eprintln!("notes-node: {refused}"); return Ok(ExitCode::FAILURE); }
            };
            let vaults = d.vaults.iter().map(|(_, name)| name.as_str()).collect::<Vec<_>>().join(", ");
            if apply { notes_node::audit::event("account_deleted", &[("by", "admin"), ("user", &d.id)]); }
            println!("{} {} ({})", if apply { "Usunięto" } else { "Do usunięcia:" }, d.email, d.id);
            if !d.vaults.is_empty() { println!("  jego sejfy (był w nich sam): {vaults}"); }
            if !d.left.is_empty() { println!("  członkostwo w: {} — te sejfy dostaną nowy klucz", d.left.join(", ")); }
            if !apply { println!("Nic nie zmieniono. Dodaj --confirm yes, aby usunąć."); }
            Ok(ExitCode::SUCCESS)
        }
        "reset-password" => {
            let flags = Flags::parse(rest, &["data", "user"])?;
            let who = flags.get("user").ok_or("--user is required")?;
            let (id, email, password) = admin::reset_password(&flags.data()?, who)?;
            notes_node::audit::event("password_reset", &[("by", "admin"), ("user", &id)]);
            println!("Nowe tymczasowe hasło dla {email}:\n  {password}\nPrzekaż je tej osobie; po zalogowaniu niech zmieni je w Ustawieniach → Konto.");
            Ok(ExitCode::SUCCESS)
        }
        "signup-code" => {
            let flags = Flags::parse(rest, &["data", "label", "days"])?;
            let days = flags.number("days", 7u32)?;
            // a fresh server has no auth.db until its first `serve`: the first account needs a code before that
            notes_node::auth::AuthService::open(&flags.data()?).map_err(|_| "nie udało się otworzyć auth.db".to_string())?;
            let code = admin::create_signup_code(&flags.data()?, flags.get("label").unwrap_or(""), days)?;
            notes_node::audit::event("signup_code_created", &[("by", "admin"), ("code", &code.id)]);
            println!("Kod rejestracyjny: {} (ważny do {})", code.code, day(code.expires_at));
            println!("Kod działa raz. Przekaż go osobie, która ma założyć konto.");
            Ok(ExitCode::SUCCESS)
        }
        "signup-codes" => {
            let data = Flags::parse(rest, &["data"])?.data()?;
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX));
            let codes = admin::list_signup_codes(&data)?;
            if codes.is_empty() { println!("Nie ma kodów rejestracyjnych."); }
            for c in codes {
                let state = match (c.used_at, c.used_by_email) {
                    (Some(_), Some(email)) => format!("użyty przez {email}"),
                    (Some(_), None) => "użyty".to_string(),
                    _ if c.expires_at <= now => "wygasł".to_string(),
                    _ => "nieużyty".to_string(),
                };
                println!("{}  {:<24} wygasa {}  {state}", c.id, c.label, day(c.expires_at));
            }
            Ok(ExitCode::SUCCESS)
        }
        "agents" => {
            let Some((action, rest)) = rest.split_first() else { return Err("agents needs disable, enable or revoke-all".to_string()); };
            match action.as_str() {
                "disable" | "enable" => {
                    let data = Flags::parse(rest, &["data"])?.data()?;
                    let disable = action == "disable";
                    notes_node::agents::set_disabled(&data, disable)?;
                    notes_node::audit::event(if disable { "agents_disabled" } else { "agents_enabled" }, &[("by", "admin")]);
                    println!("{}", if disable { "Czaty Claude są wyłączone (działa bez restartu)." } else { "Czaty Claude są włączone." });
                }
                "revoke-all" => {
                    let flags = Flags::parse(rest, &["data", "confirm"])?;
                    let apply = flags.get("confirm") == Some("yes");
                    let count = notes_node::agents::revoke_all(&flags.data()?, apply)?;
                    if apply {
                        notes_node::audit::event("agents_revoked_all", &[("by", "admin"), ("count", &count.to_string())]);
                        println!("Odłączono czaty: {count}. Ich sejfy dostaną nowy klucz przy następnym otwarciu przez administratora.");
                    } else {
                        println!("Do odłączenia czatów: {count}. Nic nie zmieniono. Dodaj --confirm yes, aby odłączyć wszystkie.");
                    }
                }
                other => return Err(format!("unknown agents action {other}")),
            }
            Ok(ExitCode::SUCCESS)
        }
        other => Err(format!("unknown command {other}")),
    }
}

#[tokio::main]
async fn serve(opts: Options) -> notes_sync::Result<()> {
    let models = opts.data.join("models");
    let running = start(opts).await?;
    eprintln!(
        "notes-node: HTTP on {}, node id {}",
        running.http_addr,
        hex(&running.ticket().node)
    );
    if let Some(addr) = running.admin_addr {
        eprintln!("notes-node: panel administratora na http://{addr}/admin (tylko z sieci lokalnej)");
    }
    // the speech models live on this server's disk, not in the image (docs/DOCKER-WEB.md "Modele dyktowania")
    if std::fs::read_dir(&models).map_or(true, |mut d| d.next().is_none()) {
        eprintln!("notes-node: brak modeli dyktowania w {} (dyktowanie pokaże błąd ładowania); wgraj je: docs/DOCKER-WEB.md", models.display());
    }
    wait_for_stop().await;
    running
        .shutdown()
        .await
        .map_err(|e| notes_sync::Error::Transport(e.to_string()))
}

/// Ctrl-C, or SIGTERM from the container runtime.
async fn wait_for_stop() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        if let Ok(mut term) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = term.recv() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

/// `YYYY-MM-DD` of a unix time in seconds (accounts) or milliseconds.
fn day(t: i64) -> String {
    let days = (if t > 100_000_000_000 { t / 1000 } else { t }).div_euclid(86_400);
    // civil-from-days (Howard Hinnant), to avoid a date dependency for one column
    let z = days + 719_468;
    let (era, doe) = (z.div_euclid(146_097), z.rem_euclid(146_097));
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let (d, m) = (doy - (153 * mp + 2) / 5 + 1, if mp < 10 { mp + 3 } else { mp - 9 });
    format!("{:04}-{m:02}-{d:02}", yoe + era * 400 + i64::from(m <= 2))
}

fn hex(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn day_formats_seconds_and_milliseconds() {
        assert_eq!(super::day(0), "1970-01-01");
        assert_eq!(super::day(951_782_400), "2000-02-29");
        assert_eq!(super::day(1_793_218_198_894), "2026-10-28");
    }
}
