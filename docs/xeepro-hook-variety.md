# XeePro hook variety

Updated 2026-10-11 after the user requested a varied mix rather than only question hooks. This supersedes the question-heavy generation policy in `xeepro-question-hook-style.md`; its two verified clip examples and language/grounding checks remain valid.

The shared writer requests three different formats in each supported candidate pool:

- A direct question with a specific reason to watch, in the user's reference style.
- A non-question clickbait statement using a concrete curiosity gap, with a payoff actually present in the clip.
- A story, contrast, emotional or bold alternative with a different structure.

Most candidates should be statements. The existing category pool is retained, and each candidate still undergoes the same grammar, clarity, attribution, context, grounding and misleading-risk checks. Clickbait changes presentation; it cannot invent events, identities, stakes or explanations.

After review, the first few options span these formats when approved candidates are available. The strongest recommended hook remains first, including a preserved existing hook or an explicitly requested category. The additional alternative category varies by clip/request using a seeded order; cached responses remain stable on reload, while a different clip or regeneration request can surface a different angle. This ordering applies only to XeePro. A short approved pool stays short instead of receiving fabricated alternatives.

Regression tests in `test-creative-hook-pipeline.cjs` exercise the writer/reviewer policy, visible mixed formats, preserved recommendation, variation across clips, cache stability and short-pool behavior. The wider grammar and shared integration suites also pass. This final variety adjustment was verified offline, without another live AI generation run. The earlier real-media acceptance results document the preceding question-led policy.

On 2026-10-11 the user authorized committing and pushing all accumulated hook and music fixes. Git publication status is reported in the task's final response; a push is not itself a verified production deployment.
