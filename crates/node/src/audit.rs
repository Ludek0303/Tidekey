//! Security events, one line each on stderr, which is the container log (`docker logs`): who did what and when the
//! log line was written. Never a password, a key, an IP address or an email address: accounts appear as their id.

/// Every line written, for tests that check what reaches the log.
#[cfg(test)]
pub static CAPTURED: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// `notes-node audit: event=<name> k=v …`; spaces inside a value become `_`, so a line always splits the same way.
pub fn event(name: &str, fields: &[(&str, &str)]) {
    let mut line = format!("notes-node audit: event={name}");
    for (key, value) in fields {
        line.push_str(&format!(" {key}={}", value.replace(char::is_whitespace, "_")));
    }
    #[cfg(test)]
    CAPTURED.lock().unwrap().push(line.clone());
    eprintln!("{line}");
}
