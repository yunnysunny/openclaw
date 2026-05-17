// Stub: re-introduced post-merge. Branch's rewriter logic was inlined in
// attempt.ts before the upstream refactor split it into this module. Returning
// the input unchanged is safe — it simply skips the rewrite step.
export function rewriteSubmittedPromptTranscript<T>(params: {
  messages: T[];
  [key: string]: unknown;
}): T[] {
  return params.messages;
}
