use crate::render::render_html;

const EXAMPLE: &str = "| Zadanie | Start | Koniec | Dni |\n\
    |---|---|---|---|\n\
    | Projekt | 2026-10-01 | 2026-10-19 | =C2-B2 |\n\
    | Testy | 19.10.2026 | =B3+14 | =C3-B3 |\n\
    | **Razem** | | | =SUMA(D2:D3) |";

#[test]
fn renders_basic_markdown() {
    let html = render_html(
        "# Tytuł\n\n**tak** i ~~nie~~\n\n- [x] gotowe\n- [ ] nie\n",
        0,
    );
    assert!(html.contains("<h1>Tytuł</h1>"), "{html}");
    assert!(html.contains("<strong>tak</strong>"));
    assert!(html.contains("<del>nie</del>"));
    assert!(html.contains("type=\"checkbox\""));
    assert!(html.contains("<li>"));
}

#[test]
fn polish_text_survives() {
    let html = render_html("Zażółć gęślą jaźń — „cytat”", 0);
    assert!(html.contains("Zażółć gęślą jaźń — „cytat”"), "{html}");
}

#[test]
fn example_table_shows_formula_results() {
    let html = render_html(EXAMPLE, 0);
    assert!(html.contains("<table>"), "{html}");
    for value in ["18", "02.11.2026", "14", "32"] {
        assert!(
            html.contains(&format!(">{value}</span>")),
            "{value} missing: {html}"
        );
    }
    assert!(html.contains("class=\"formula-result formula-number\""));
    assert!(html.contains("title=\"=C2-B2\""));
    assert!(
        html.contains(">Projekt</td>") || html.contains(">Projekt<"),
        "{html}"
    );
}

#[test]
fn formula_error_gets_error_class() {
    let html = render_html("| a |\n|---|\n| =1/0 |", 0);
    assert!(
        html.contains("class=\"formula-result formula-error\""),
        "{html}"
    );
    assert!(html.contains("#DZIEL/0!"));
}

#[test]
fn plain_cells_are_not_touched() {
    let html = render_html("| a | b |\n|---|---|\n| 1 | =x |", 0);
    assert!(html.contains("<td>1</td>"));
    assert!(html.contains("=x"));
}

#[test]
fn raw_html_is_escaped() {
    let html = render_html(
        "<script>alert(1)</script>\n\n<b>x</b> <img src=x onerror=alert(1)>",
        0,
    );
    assert!(!html.contains("<script"), "{html}");
    assert!(!html.contains("<img"), "{html}");
    assert!(!html.contains("<b>"), "{html}");
    assert!(html.contains("&lt;script&gt;"));
}

#[test]
fn raw_html_in_table_cell_is_escaped() {
    let html = render_html("| a |\n|---|\n| <img src=x onerror=alert(1)> |", 0);
    assert!(!html.contains("<img"), "{html}");
    assert!(html.contains("&lt;img"), "{html}");
}

#[test]
fn javascript_links_lose_href() {
    for md in [
        "[x](javascript:alert(1))",
        "[x](JaVaScRiPt:alert(1))",
        "[x]( javascript:alert(1))",
        "[x](&#106;avascript:alert(1))",
        "[x](vbscript:msgbox)",
        "[x](file:///etc/passwd)",
    ] {
        let html = render_html(md, 0);
        assert!(!html.contains("href"), "{md}: {html}");
        assert!(!html.contains("javascript:"), "{md}: {html}");
        assert!(
            html.contains(">x</a>") || html.contains(">x"),
            "{md}: {html}"
        );
    }
}

#[test]
fn data_images_lose_src() {
    let html = render_html("![i](data:text/html,<script>alert(1)</script>)", 0);
    assert!(!html.contains("<img"), "{html}");
    assert!(!html.contains("data:"), "{html}");
    assert!(!html.contains("<script"), "{html}");
}

#[test]
fn safe_links_keep_href() {
    let html = render_html(
        "[a](https://example.pl) [b](mailto:x@example.test) [c](Notatka.md) [d](#top)",
        0,
    );
    assert!(html.contains("href=\"https://example.pl\""), "{html}");
    assert!(html.contains("href=\"mailto:x@example.test\""));
    assert!(html.contains("href=\"Notatka.md\""));
    assert!(html.contains("href=\"#top\""));
}

#[test]
fn wikilinks_have_target_and_no_href() {
    let html = render_html("Zobacz [[Plan]] i [[Projekty/Plan|plan]].", 0);
    assert!(
        html.contains("<a class=\"wikilink\" data-target=\"Plan\">Plan</a>"),
        "{html}"
    );
    assert!(
        html.contains("<a class=\"wikilink\" data-target=\"Projekty/Plan\">plan</a>"),
        "{html}"
    );
    assert!(!html.contains("href"));
}

#[test]
fn header_formula_is_evaluated() {
    let html = render_html("| =1+1 | b |\n|---|---|\n| x | y |", 0);
    assert!(html.contains(">2</span></th>"), "{html}");
}

#[test]
fn wikilink_target_is_escaped() {
    let html = render_html("[[a\"><script>]]", 0);
    assert!(!html.contains("<script"), "{html}");
    assert!(!html.contains("\"><"), "{html}");
}

/// The content of each `<td>`/`<th>` in document order.
fn cells(html: &str) -> Vec<&str> {
    html.split("<t")
        .skip(1)
        .filter(|s| ["d>", "h>", "d ", "h "].iter().any(|p| s.starts_with(p)))
        .collect()
}

#[test]
fn escaped_pipe_never_moves_a_result() {
    let html = render_html("| a | b |\n|---|---|\n| x \\| =5 | z |", 0);
    let c = cells(&html);
    assert!(c.len() >= 2, "{html}");
    assert!(
        !c[1].contains("formula-result"),
        "result in column B: {html}"
    );
    assert!(!c[1].contains(">5<"), "{html}");
}

#[test]
fn ragged_rows_keep_formulas_in_matching_cells() {
    let html = render_html("| a | b |\n|---|---|\n| =1+1 |\n| =2+2 | =3+3 | =9 |", 0);
    assert!(html.contains(">2</span>"), "{html}");
    assert!(html.contains(">4</span>"), "{html}");
    assert!(html.contains(">6</span>"), "{html}");
    assert!(!html.contains(">9</span>"), "{html}");
}

#[test]
fn protocol_relative_links_lose_href() {
    for md in ["[a](//evil.com/x)", "[a](/\\evil.com)", "[a](\\\\evil.com)"] {
        let html = render_html(md, 0);
        assert!(!html.contains("href"), "{md}: {html}");
        assert!(html.contains(">a<"), "{md}: {html}");
    }
}

#[test]
fn formula_with_escaped_pipe_shows_its_result() {
    let html = render_html("| x | y |\n|---|---|\n| =\"a\\|b\" | =1+1 |", 0);
    assert!(html.contains(">a|b</span>"), "{html}");
    assert!(html.contains(">2</span>"), "{html}");
}

#[test]
fn wikilink_embeds_keep_their_target_for_the_ui() {
    let html = render_html("![[plik:0123456789abcdef0123456789abcdef|320]] ![[assets/a.png]]", 0);
    assert!(html.contains("<a class=\"wikilink embed\" data-target=\"plik:0123456789abcdef0123456789abcdef\">320</a>"), "{html}");
    assert!(html.contains("<a class=\"wikilink embed\" data-target=\"assets/a.png\">"), "{html}");
    assert!(!html.contains("<img"), "{html}");
}
