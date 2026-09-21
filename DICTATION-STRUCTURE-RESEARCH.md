# Dictation structure research — 2026-09-21

## Findings from official sources

- Wispr Flow documents automatic lists from numbers or sequence words, named punctuation, and explicit new-line/paragraph commands. https://docs.wisprflow.ai/articles/5373093536-How-do-I-use-Smart-Formatting-%26-Backtrack
- Wispr Flow's Auto Cleanup guide distinguishes raw output, Light (fillers and grammar), and Medium (clarity and conciseness). Its changelog additionally describes High and raw-history recovery; the pages are not fully consistent about available levels. https://docs.wisprflow.ai/articles/4283510616-Auto-Cleanup:-control-how-much-Flow-edits-your-dictation and https://wisprflow.ai/whats-new
- Willow documents contextual paragraphs, counted lists, explicit bullet commands and natural pauses as list/paragraph cues. https://help.willowvoice.com/en/articles/13183983-voice-commands-and-automatic-formatting-guide
- Superwhisper describes separate voice and language models, task-specific modes, and a specialized local cleanup model. Its published benchmark results are vendor claims, not independent validation of Speakflow. https://superwhisper.com/blog/s1

These sources establish product behavior. They do not disclose Wispr's exact prompts, model configuration, or complete decision logic. No claim of reverse engineering or matched accuracy is justified.

## Speakflow decisions

Use light cleanup in normal dictation: minimal grammar corrections, punctuation, topic-based paragraphs, counted lists, and explicit bullets. Keep rewriting in the existing separate transform actions. Honor the user's preference that firstly/secondly remain spoken transitions, even though Wispr also uses sequence words to infer lists.

Retain order, uncertainty, negation, quantities, names, and distinct ideas. Do not summarize rambling or invent headings/sign-offs. Use text list markers and blank lines compatible with Notepad and email. Do not treat every "also" as a topic change or every number as a counter.

Short sentences now reach the formatter when formatting is enabled; this adds a model request for 3–24-word clips that previously skipped it. Keep the existing timeout and raw fallback. Actual latency and model compliance require live evaluation; gate/guard tests alone do not prove generated quality.

## Implementation and verification

Update both desktop and server prompts/gates. Correct the fidelity guard's asymmetric handling of retained ordinal words; support digit-spelled bare counters without dropping numeric protection. Regression fixtures exercise spoken and digit lists, bullets, retained firstly/secondly, grammar agreement, topic paragraphs, and rejected numeric/negation changes through both insertion decision paths.

Pending acceptance: live English audio through the deployed formatter, short-clip latency measurements, and native Notepad/email insertion of multiline output. No acoustic pause-based implementation is claimed: the current formatting pass uses transcript text and app context.
