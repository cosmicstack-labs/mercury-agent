# Z.ai (GLM) Provider

Z.ai provides OpenAI-compatible API access to GLM language models, including the GLM Coding Plan for coding-focused tasks.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ZAI_API_KEY` | — | Your Z.ai API key (required) |
| `ZAI_BASE_URL` | `https://api.z.ai/api/paas/v4` | General API endpoint |
| `ZAI_MODEL` | `glm-5.1` | Model to use |
| `ZAI_ENABLED` | `true` | Enable/disable provider |
| `ZAI_CODING_PLAN_ENABLED` | `false` | Opt into GLM Coding Plan endpoint |
| `ZAI_CODING_PLAN_BASE_URL` | `https://api.z.ai/api/coding/paas/v4` | Coding Plan endpoint |

## Setup

### Via Setup Wizard
Run `mercury doctor` and select **Z.ai (GLM)** from the provider list.

### Via Environment Variables
Add to your `.env` or `~/.mercury/.env`:

```
ZAI_API_KEY=your-api-key-here
ZAI_MODEL=glm-5.1
DEFAULT_PROVIDER=zai
```

## Supported Models

| Model | Description |
|-------|-------------|
| `glm-5.1` | Latest GLM model (recommended) |
| `glm-5` | GLM 5 series |
| `glm-4-plus` | GLM 4 enhanced |
| `glm-4-air` | GLM 4 lightweight |
| `glm-4-flash` | GLM 4 fast inference |
| `glm-4-long` | GLM 4 extended context |
| `glm-4` | GLM 4 base |

The setup wizard auto-fetches available models from your Z.ai account.

## GLM Coding Plan

The GLM Coding Plan provides benefits for coding-related tasks through a dedicated endpoint.

### Enabling

```
env
ZAI_CODING_PLAN_ENABLED=true
```

### ⚠️ Compliance Notice

> **Important**: GLM Coding Plan benefits are limited to officially supported tools and products.
> By enabling `ZAI_CODING_PLAN_ENABLED=true`, you acknowledge that:
> - You are responsible for ensuring your usage complies with your Z.ai plan terms.
> - Mercury is **not** an officially supported product of Z.ai unless explicitly verified.
> - You should review Z.ai's terms of service for the Coding Plan before use.
> - The general endpoint (`ZAI_BASE_URL`) is used by default and is recommended unless you have an active Coding Plan subscription.

### How it works

When `ZAI_CODING_PLAN_ENABLED=true`:
- Mercury uses `https://api.z.ai/api/coding/paas/v4` instead of the general endpoint
- All requests are routed through the Coding Plan endpoint
- Model selection and behavior remain the same

When `ZAI_CODING_PLAN_ENABLED=false` (default):
- Mercury uses `https://api.z.ai/api/paas/v4` (general endpoint)
- Standard API access and pricing applies

## Architecture

Z.ai uses Mercury's OpenAI-compatible provider path (`OpenAICompatProvider`), which leverages:
- `@ai-sdk/openai` for the API client
- Vercel AI SDK (`ai` package) for `generateText` and `streamText`
- Bearer token authentication

No additional dependencies are required.

## Security
- API keys are never logged or exposed in responses
- Keys are validated during setup (must look like a real token)
- Keys are stored in `~/.mercury/.env` with standard file permissions

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "No LLM providers available" | Set `ZAI_API_KEY` in your environment |
| Model not found | Check available models with `mercury doctor` |
| Coding Plan errors | Verify your Coding Plan subscription and terms |
| Connection refused | Check network access to `api.z.ai` |
