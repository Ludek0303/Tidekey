//! Civil calendar arithmetic (Howard Hinnant's days_from_civil / civil_from_days)
//! and the two date notations accepted in cells.

use super::DateFmt;

pub(crate) fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub(crate) fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn is_leap(y: i64) -> bool {
    y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(y) => 29,
        2 => 28,
        _ => 0,
    }
}

/// Days since 1970-01-01 for a valid calendar date, `None` otherwise.
pub(crate) fn from_ymd(y: i64, m: i64, d: i64) -> Option<i32> {
    if !(1..=12).contains(&m) || d < 1 || d > days_in_month(y, m) {
        return None;
    }
    i32::try_from(days_from_civil(y, m, d)).ok()
}

fn digits(s: &str) -> Option<i64> {
    if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) {
        s.parse().ok()
    } else {
        None
    }
}

/// `YYYY-MM-DD`
pub(crate) fn parse_iso(s: &str) -> Option<i32> {
    if s.len() != 10 || s.get(4..5) != Some("-") || s.get(7..8) != Some("-") {
        return None;
    }
    from_ymd(
        digits(s.get(0..4)?)?,
        digits(s.get(5..7)?)?,
        digits(s.get(8..10)?)?,
    )
}

/// `DD.MM.YYYY`
pub(super) fn parse_dotted(s: &str) -> Option<i32> {
    if s.len() != 10 || s.get(2..3) != Some(".") || s.get(5..6) != Some(".") {
        return None;
    }
    from_ymd(
        digits(s.get(6..10)?)?,
        digits(s.get(3..5)?)?,
        digits(s.get(0..2)?)?,
    )
}

pub(super) fn format(days: i32, fmt: DateFmt) -> String {
    let (y, m, d) = civil_from_days(i64::from(days));
    match fmt {
        DateFmt::Iso => format!("{y:04}-{m:02}-{d:02}"),
        DateFmt::Dotted => format!("{d:02}.{m:02}.{y:04}"),
    }
}
