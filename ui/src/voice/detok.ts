// SentencePiece tokens to text. parakeet.js 1.4.4 does this with /\s+(?=[^\w\s])/, and without the u flag `\w` is
// ASCII only, so it dropped the space before every word starting with ą, ć, ę, ł, ń, ó, ś, ź or ż ("jest łatwo" came
// out "jestłatwo"). Same rule here with Unicode classes; a space before an opening bracket or quote also stays.
export function decodeTokens(tokens: readonly (string | undefined)[]): string {
  return tokens
    .filter((t): t is string => t !== undefined)
    .join("")
    .replace(/▁/g, " ")
    .replace(/\s+(?=[^\p{L}\p{N}_\s([{„«])/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}
