// Stub: re-introduced post-merge. Branch's rewriter logic was inlined in
// attempt.ts before the upstream refactor split it into this module. Returning
// the input unchanged is safe — it simply skips the rewrite step.
export function rewriteSubmittedPromptTranscript(params: {
  messages: unknown[];
  [key: string]: unknown;
}): { messages: unknown[] } {
  return { messages: params.messages };
}
