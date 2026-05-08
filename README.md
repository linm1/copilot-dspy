# CopilotLM: Production-Ready GitHub Copilot Integration for DSPy

A production-grade Python library that enables GitHub Copilot OAuth tokens as a language model backend for Stanford's DSPy framework. Run structured AI programs with Copilot's multimodal LLMs (gpt-4o, Claude 4.6, etc.) exposed via the Copilot API gateway.

## Features

- **Custom DSPy BaseLM Implementation** - Drop-in replacement for DSPy's standard LM clients
- **OAuth Device Flow Authentication** - Secure token acquisition without manual browser login flows
- **Automatic Token Refresh** - Handles JWT expiration with seamless refresh
- **Response Caching** - In-memory cache with TTL to reduce API calls and costs
- **Comprehensive Error Handling** - Automatic retry with exponential backoff, token refresh on 401
- **Token Usage Monitoring** - Track input/output tokens and requests for cost analysis
- **Thread-Safe Operations** - Locking mechanisms for multi-threaded environments
- **Type Hints & Logging** - Full type annotations and structured logging for production use
- **Fallback Strategies** - Support for multi-model failover patterns

## Table of Contents

1. [Quick Start](#quick-start)
2. [Installation](#installation)
3. [Authentication](#authentication)
4. [API Reference](#api-reference)
5. [Usage Examples](#usage-examples)
6. [Advanced Patterns](#advanced-patterns)
7. [Monitoring & Metrics](#monitoring--metrics)
8. [Troubleshooting](#troubleshooting)
9. [Deployment](#deployment)
10. [Contributing](#contributing)

---

## Quick Start

```python
import dspy
from copilot_dspy_client import CopilotLM

# Initialize with automatic OAuth authentication
lm = CopilotLM(
    model="gpt-4o",
    temperature=0.7,
    max_tokens=2048,
)

# Configure DSPy
dspy.configure(lm=lm)

# Define a DSPy module
class QuestionAnswerer(dspy.Module):
    def __init__(self):
        super().__init__()
        self.generate = dspy.ChainOfThought("question -> answer")
    
    def forward(self, question: str):
        return self.generate(question=question)

# Execute
qa = QuestionAnswerer()
result = qa(question="What is machine learning?")
print(result.answer)

# Check token usage
print(lm.get_usage())
```

---

## Installation

### Prerequisites

- Python 3.9+
- GitHub Copilot subscription
- Active GitHub account

### Install Package

```bash
pip install dspy-ai requests
git clone https://github.com/linm1/copilot-dspy.git
cd copilot-dspy
pip install -r requirements.txt
```

---

## Authentication

### Initial Setup (Device Flow)

On first run, CopilotLM initiates GitHub's OAuth device flow:

```python
from copilot_dspy_client import CopilotLM

lm = CopilotLM(model="gpt-4o")
# Prompts:
# 1. Visit: https://github.com/login/device
# 2. Enter code: XXXX-XXXX
# 3. Authorize application
# Token saved to ~/.config/copilot-dspy/token.json
```

### Token Storage

Tokens are stored securely with `600` (rw-------) permissions:

```
~/.config/copilot-dspy/
├── token.json           # OAuth tokens (encrypted filesystem recommended)
└── ...
```

On Windows the repository's token file permission step is a no-op; ensure you protect the token file appropriately on non-POSIX systems.

Token data structure:

```json
{
  "access_token": "ghu_...",
  "refresh_token": "ghr_...",
  "token_type": "Bearer",
  "expires_at": "2025-12-31T23:59:59",
  "acquired_at": "2024-01-01T00:00:00"
}
```

### Custom Token Manager

```python
from copilot_dspy_client import CopilotLM, CopilotTokenManager

token_manager = CopilotTokenManager(
    config_dir="/custom/config/path"
)

lm = CopilotLM(
    model="gpt-4o",
    token_manager=token_manager,
)
```

### Environment Variable Support

```bash
# Override the GitHub client ID used for device-flow (optional)
export GITHUB_CLIENT_ID=Iv1.b507a08c87ecfe98

# To customise the token storage directory, pass `config_dir` when
# creating a `CopilotTokenManager` (the library does not read a
# COPILOT_TOKEN_DIR environment variable automatically):

# Python example
# from copilot_dspy_client import CopilotTokenManager
# token_manager = CopilotTokenManager(config_dir="/custom/config/path")
# lm = CopilotLM(token_manager=token_manager)
```

---

## API Reference

### CopilotLM

Main language model client class.

#### Initialization

```python
CopilotLM(
    model: str = "gpt-4o",
    cache_ttl: int = 3600,
    temperature: float = 0.7,
    max_tokens: int = 2048,
    top_p: float = 1.0,
    token_manager: Optional[CopilotTokenManager] = None,
)
```

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `model` | str | `"gpt-4o"` | Model ID string — see Available Models below |
| `cache_ttl` | int | 3600 | Cache time-to-live in seconds |
| `temperature` | float | 0.7 | Sampling temperature (0.0-2.0) |
| `max_tokens` | int | 2048 | Maximum response tokens |
| `top_p` | float | 1.0 | Nucleus sampling parameter |
| `token_manager` | CopilotTokenManager | None | Custom token manager |

#### Available Models

Verified via `GET https://api.githubcopilot.com/models` (May 2026). Availability depends on your Copilot plan.

**OpenAI**

| Model ID | Name |
|----------|------|
| `gpt-5.5` | GPT-5.5 |
| `gpt-5.4` | GPT-5.4 |
| `gpt-5.4-mini` | GPT-5.4 mini |
| `gpt-5.3-codex` | GPT-5.3-Codex |
| `gpt-5.2-codex` | GPT-5.2-Codex |
| `gpt-5.2` | GPT-5.2 |
| `gpt-5-mini` | GPT-5 mini |
| `gpt-4.1-2025-04-14` | GPT-4.1 |
| `gpt-4o-2024-11-20` | GPT-4o |
| `gpt-4o-2024-08-06` | GPT-4o |
| `gpt-4o-mini-2024-07-18` | GPT-4o mini |
| `gpt-4-0613` | GPT-4 |
| `gpt-3.5-turbo-0613` | GPT-3.5 Turbo |

**Anthropic**

| Model ID | Name |
|----------|------|
| `claude-opus-4.7` | Claude Opus 4.7 |
| `claude-sonnet-4.6` | Claude Sonnet 4.6 |
| `claude-sonnet-4.5` | Claude Sonnet 4.5 |
| `claude-opus-4.5` | Claude Opus 4.5 |
| `claude-haiku-4.5` | Claude Haiku 4.5 |

**Google**

| Model ID | Name |
|----------|------|
| `gemini-3.1-pro-preview` | Gemini 3.1 Pro |
| `gemini-3-flash-preview` | Gemini 3 Flash (Preview) |
| `gemini-2.5-pro` | Gemini 2.5 Pro |

**Other**

| Model ID | Name |
|----------|------|
| `grok-code-fast-1` | Grok Code Fast 1 |
| `oswe-vscode-prime` | Raptor mini (Preview) |
| `text-embedding-3-small` | Embedding V3 small |

To refresh this list, update the model table in this README using the repository's current model-discovery workflow. The previously documented command referenced a script path that does not exist in this repository.

---

#### Methods

##### `forward(prompt: str, **kwargs) -> str`

Execute text completion.

```python
response = lm.forward(
    "Explain quantum computing",
    temperature=0.5,
    max_tokens=1024,
)
```

##### `__call__(messages: List[Dict[str, str]], **kwargs) -> List[Dict[str, Any]]`

Chat completion with OpenAI-format interface.

```python
response = lm(
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "What is DSPy?"},
    ],
    temperature=0.7,
)
print(response["choices"][0]["message"]["content"])
```

##### `get_usage() -> Dict[str, int]`

Retrieve token usage statistics.

```python
usage = lm.get_usage()
print(f"Total tokens: {usage['total_tokens']}")
print(f"Requests: {usage['requests']}")
```

##### `reset_usage() -> None`

Reset usage counters.

```python
lm.reset_usage()
```

---

### CopilotTokenManager

Manages OAuth token lifecycle.

#### Methods

##### `get_token(force_refresh: bool = False) -> str`

Get valid access token, automatically refreshing if expired.

```python
token = token_manager.get_token()

# Force refresh
token = token_manager.get_token(force_refresh=True)
```

---

### CopilotLMCache

Simple in-memory cache for API responses.

#### Initialization

```python
CopilotLMCache(ttl_seconds: int = 3600)
```

#### Methods

##### `get(key: str) -> Optional[Any]`
##### `set(key: str, value: Any) -> None`

---

## Usage Examples

### Example 1: Basic Question Answering

```python
import dspy
from copilot_dspy_client import CopilotLM

# Setup
lm = CopilotLM(model="gpt-4o")
dspy.configure(lm=lm)

# Define module
class QA(dspy.Module):
    def __init__(self):
        super().__init__()
        self.answer = dspy.Predict("question -> answer")
    
    def forward(self, question):
        return self.answer(question=question)

# Execute
qa = QA()
result = qa(question="What is DNA?")
print(result.answer)
```

### Example 2: Multi-Stage Analysis

```python
class DocumentAnalyzer(dspy.Module):
    def __init__(self):
        super().__init__()
        self.summarize = dspy.ChainOfThought(
            "document -> summary"
        )
        self.extract_entities = dspy.Predict(
            "text -> entities"
        )
        self.classify = dspy.Predict(
            "text -> category"
        )
    
    def forward(self, document):
        summary = self.summarize(document=document).summary
        entities = self.extract_entities(text=summary).entities
        category = self.classify(text=summary).category
        
        return dspy.Prediction(
            summary=summary,
            entities=entities,
            category=category,
        )

analyzer = DocumentAnalyzer()
result = analyzer(document="...")
```

### Example 3: Chain of Thought Reasoning

```python
class MathSolver(dspy.Module):
    def __init__(self):
        super().__init__()
        self.solve = dspy.ChainOfThought(
            "problem -> reasoning | answer"
        )
    
    def forward(self, problem):
        return self.solve(problem=problem)

solver = MathSolver()
result = solver(problem="What is 25% of 1000?")
print(f"Reasoning: {result.reasoning}")
print(f"Answer: {result.answer}")
```

### Example 4: With Custom Configuration

```python
# Basic configuration is done by instantiating `CopilotLM` directly.
# The examples that reference `copilot_dspy_advanced` are illustrative
# helper modules and are not included in this repository.

# Example: configure from environment variables (simple)
# export COPILOT_MODEL=gpt-4o
# export COPILOT_TEMPERATURE=0.5
from copilot_dspy_client import CopilotLM

lm = CopilotLM(
    model=os.getenv("COPILOT_MODEL", "gpt-4o"),
    temperature=float(os.getenv("COPILOT_TEMPERATURE", "0.7")),
)
```

---

## Advanced Patterns

Note: Some examples in this section reference illustrative helper modules (RobustProgram, ProgramMonitor, CopilotConfig) that are not included in this repository. They demonstrate patterns you can implement around `CopilotLM`.

### Pattern 1: Error Handling & Fallback

```python
from copilot_dspy_advanced import RobustProgram

primary = CopilotLM(model="gpt-4o")
fallback = dspy.LM("openai/gpt-3.5-turbo")

program = RobustProgram(lm=primary, fallback_lm=fallback)

try:
    result = program(question="...")
except Exception as e:
    print(f"All LMs failed: {e}")
```

### Pattern 2: Monitoring & Metrics

```python
from copilot_dspy_advanced import ProgramMonitor
import time

lm = CopilotLM(model="gpt-4o")
monitor = ProgramMonitor(lm)

for _ in range(10):
    start = time.time()
    try:
        result = program(...)
        monitor.log_execution(time.time() - start, success=True)
    except Exception as e:
        monitor.log_execution(time.time() - start, success=False, error=str(e))

report = monitor.get_report()
print(report)
```

### Pattern 3: Batch Processing

```python
lm = CopilotLM(model="gpt-4o")
dspy.configure(lm=lm)

texts = ["text1", "text2", "text3"]
classifier = MultiStageClassifier()

results = []
for text in texts:
    result = classifier(text=text)
    results.append(result)

usage = lm.get_usage()
print(f"Processed {len(texts)} texts using {usage['total_tokens']} tokens")
```

### Pattern 4: Caching for Cost Optimization

```python
# Default: 1-hour cache TTL
lm = CopilotLM(model="gpt-4o", cache_ttl=3600)

# Identical requests hit cache (no API call)
result1 = lm(messages=[...])  # API call
result2 = lm(messages=[...])  # Cache hit

usage = lm.get_usage()
# requests=1 (only first call counts)
```

---

## Monitoring & Metrics

### Usage Statistics

```python
lm = CopilotLM(model="gpt-4o")
# ... run some operations ...
usage = lm.get_usage()

print(f"Requests: {usage['requests']}")
print(f"Input tokens: {usage['input_tokens']}")
print(f"Output tokens: {usage['output_tokens']}")
print(f"Total tokens: {usage['total_tokens']}")
```

### Cost Estimation

Copilot's pricing typically follows:
- Input: $0.003 per 1K tokens (gpt-4o)
- Output: $0.006 per 1K tokens (gpt-4o)

```python
def estimate_cost(usage, input_price=0.003, output_price=0.006):
    input_cost = (usage['input_tokens'] / 1000) * input_price
    output_cost = (usage['output_tokens'] / 1000) * output_price
    return input_cost + output_cost

cost = estimate_cost(lm.get_usage())
print(f"Estimated cost: ${cost:.4f}")
```

### Logging

```python
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("copilot_dspy_client")

# Now all operations are logged
# INFO - Request 1: input=50, output=10
# DEBUG - Cache hit for request
```

---

## Troubleshooting

### Issue: "Token acquisition failed"

**Cause:** OAuth device flow was interrupted or timed out.

**Solution:**
```python
# Force re-authentication
token_manager = CopilotTokenManager()
token_manager.get_token(force_refresh=True)
```

### Issue: "401 Unauthorized"

**Cause:** Token expired and refresh failed.

**Solution:**
```bash
# Remove stale token
rm ~/.config/copilot-dspy/token.json

# Re-authenticate on next run
lm = CopilotLM(model="gpt-4o")
```

### Issue: "api.githubcopilot.com connection refused"

**Cause:** Network connectivity issue or Copilot API downtime.

**Solution:**
1. Check your internet connection
2. Verify Copilot API status
3. Use fallback LM:
   ```python
   fallback = dspy.LM("openai/gpt-4o")
   program = RobustProgram(lm=primary, fallback_lm=fallback)
   ```

### Issue: "Cache not working"

**Cause:** TTL set to 0 or different parameters cause cache misses.

**Solution:**
```python
# Increase TTL
lm = CopilotLM(model="gpt-4o", cache_ttl=7200)

# Or disable caching
lm = CopilotLM(model="gpt-4o", cache_ttl=0)
```

---

### Environment Variables

```bash
# Model configuration
COPILOT_MODEL=gpt-4o
COPILOT_TEMPERATURE=0.7
COPILOT_MAX_TOKENS=2048
COPILOT_TOP_P=1.0

# Cache and timeout
COPILOT_CACHE_TTL=3600
COPILOT_TIMEOUT=60

# Token management
COPILOT_TOKEN_DIR=~/.config/copilot-dspy

# Logging
LOG_LEVEL=INFO
```

---

## Testing

Run the test suite:

```bash
python copilot_dspy_tests.py

# Or with pytest
pytest copilot_dspy_tests.py -v --cov=copilot_dspy_client
```

---

## Contributing

Contributions welcome. Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

---

## License

MIT License - see LICENSE file

---

## Support

- **Issues:** GitHub Issues
- **Docs:** https://dspy.ai
- **Copilot API:** https://docs.github.com/en/copilot


---

**Built with ❤️ for the DSPy community**
