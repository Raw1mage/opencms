# Model Rate Limits

This document tracks the available models and their respective rate limits for various providers.

## GitHub Copilot

As of 2026-02-01, the following rate limits apply to GitHub Copilot models.

### High Tier Models

| 模型項目 (Model Name)              | 每分鐘請求 (RPM) | 每日請求上限 (RPD) | 單次 Token 限制 | 並行請求數 |
| :--------------------------------- | :--------------: | :----------------: | :-------------- | :--------: |
| GPT-4o (OpenAI)                    |        10        |         50         | 8k in / 4k out  |     2      |
| Claude 3.5 Sonnet (Anthropic)      |        10        |         50         | 8k in / 4k out  |     2      |
| Llama 3.1 / 3.3 (405B, 70B) (Meta) |        10        |         50         | 8k in / 4k out  |     2      |
| Mistral Large (Mistral AI)         |        10        |         50         | 8k in / 4k out  |     2      |
| Command R+ (Cohere)                |        10        |         50         | 8k in / 4k out  |     2      |
| Jamba 1.5 Large (AI21)             |        10        |         50         | 8k in / 4k out  |     2      |

### Low Tier Models

| 模型項目 (Model Name)                    | 每分鐘請求 (RPM) | 每日請求上限 (RPD) | 單次 Token 限制 | 並行請求數 |
| :--------------------------------------- | :--------------: | :----------------: | :-------------- | :--------: |
| GPT-4o mini (OpenAI)                     |        15        |        150         | 8k in / 4k out  |     5      |
| Phi-4 / Phi-3.5 系列 (Microsoft)         |        15        |        150         | 8k in / 4k out  |     5      |
| Llama 3.1 / 3.2 (8B, 11B, 3B, 1B) (Meta) |        15        |        150         | 8k in / 4k out  |     5      |
| Mistral Small / Codestral (Mistral AI)   |        15        |        150         | 8k in / 4k out  |     5      |
| DeepSeek-R1 / V3 (DeepSeek)\*            |        1         |         8          | 4k in / 4k out  |     1      |

\* Note: DeepSeek models have significantly lower rate limits compared to other low-tier models.
