const INSIGHT_BLOCK = /^★ Insight(?:\s|─)|(?<![^\r\n])`★ Insight[ \t]+─{3,}`[ \t]*(?![^\r\n])/mu;

// Markdown has no lettered or "•" lists, so lines such as "A. merge it" and
// "B. hold it" are one paragraph to CommonMark and render as a solid block.
const PSEUDO_LIST_LINE = /^ {0,3}(?:\(?[A-Za-z]\)|[A-Za-z]\.|[•·▪◦‣])[ \t]+\S/u;
const FENCE_LINE = /^ {0,3}(?:`{3,}|~{3,})/u;

function hasPseudoListLines(text: string): boolean {
  let inFence = false;
  let previousMarked = false;
  for (const line of text.split(/\r?\n/u)) {
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      previousMarked = false;
      continue;
    }
    const marked = !inFence && PSEUDO_LIST_LINE.test(line);
    if (marked && previousMarked) return true;
    previousMarked = marked;
  }
  return false;
}

export function shouldPreserveAssistantLineBreaks(text: string): boolean {
  return INSIGHT_BLOCK.test(text) || hasPseudoListLines(text);
}
