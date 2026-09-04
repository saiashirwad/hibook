import DOMPurify from "dompurify";
import { marked } from "marked";

export function renderMarkdown(source: string): string {
  const rendered = marked.parse(source, { async: false });
  return DOMPurify.sanitize(rendered);
}
