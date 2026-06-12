"""
GitHub Copilot + DSPy Demo App

Run:
    python app.py

First run: triggers GitHub device flow auth — follow the printed URL and code.
Subsequent runs: reuses cached token from ~/.config/copilot-dspy/token.json.

Configure via .env (see .env for available keys).
"""

import os

import dspy
from dotenv import load_dotenv

from copilot_dspy_client import CopilotLM

load_dotenv()


# ---------------------------------------------------------------------------
# 1. Configure dspy.lm with GitHub Copilot
# ---------------------------------------------------------------------------

lm = CopilotLM(
    model=os.getenv("COPILOT_MODEL", "gpt-4o"),
    temperature=float(os.getenv("COPILOT_TEMPERATURE", "0.7")),
    max_tokens=int(os.getenv("COPILOT_MAX_TOKENS", "1024")),
    cache_ttl=int(os.getenv("COPILOT_CACHE_TTL", "3600")),
    enterprise_domain=os.getenv("COPILOT_ENTERPRISE_DOMAIN"),
)

dspy.configure(lm=lm)

print("\n" + "=" * 60)
print("DSPy configured with GitHub Copilot")
print(f"  model   : {os.getenv('COPILOT_MODEL', 'gpt-5-mini')}")
print(f"  temp    : {os.getenv('COPILOT_TEMPERATURE', '0.7')}")
print(f"  max_tok : {os.getenv('COPILOT_MAX_TOKENS', '1024')}")
print("=" * 60 + "\n")


# ---------------------------------------------------------------------------
# 2. Define DSPy programs
# ---------------------------------------------------------------------------

class Summarizer(dspy.Signature):
    """Summarize the given text into a one-sentence summary and three key points."""

    text: str = dspy.InputField()
    summary: str = dspy.OutputField(desc="one-sentence summary")
    key_points: str = dspy.OutputField(desc="three key points as a bulleted list")


summarize = dspy.Predict(Summarizer)
qa = dspy.ChainOfThought("question -> answer")


# ---------------------------------------------------------------------------
# 3. Run demo
# ---------------------------------------------------------------------------

SAMPLE_TEXT = (
    "DSPy is a framework from Stanford for programming—rather than prompting—"
    "language models. It replaces brittle prompt strings with composable Python "
    "modules (Predict, ChainOfThought, ReAct, etc.) and an optimizer that "
    "automatically tunes prompts and few-shot examples to maximize a metric. "
    "This makes AI pipelines more modular, testable, and reproducible."
)

SAMPLE_QUESTION = "What is the Copernican revolution and why did it matter?"

print("--- Task 1: Summarize a passage ---")
print(f"Input:\n  {SAMPLE_TEXT[:80]}...\n")

try:
    result = summarize(text=SAMPLE_TEXT)
    print(f"Summary    : {result.summary}")
    print(f"Key points : {result.key_points}")
except Exception as exc:
    print(f"[ERROR] Summarizer failed: {exc}")

print()
print("--- Task 2: Chain-of-thought Q&A ---")
print(f"Question: {SAMPLE_QUESTION}\n")

try:
    result2 = qa(question=SAMPLE_QUESTION)
    print(f"Answer: {result2.answer}")
except Exception as exc:
    print(f"[ERROR] Q&A failed: {exc}")

print()
print("=" * 60)
print("Token usage:")
for key, value in lm.get_usage().items():
    print(f"  {key}: {value}")
print("=" * 60 + "\n")
