# Root Cause Analysis: Google API Thought Signature Error

## 1. Issue Description
The Auto Explore task agent was failing consistently with a `400 Bad Request` error from the Google Gemini API.

**Error Message:**
```json
{
  "error": {
    "code": 400,
    "message": "Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly...",
    "status": "INVALID_ARGUMENT"
  }
}
```

## 2. Root Cause
The root cause lies in recent changes to the Google Gemini API requirements for "Thinking" models (like Gemini 3 series or models with active reasoning features).

1.  **Strict Validation:** The API now strictly enforces that any `functionCall` part in the conversation history must be accompanied by a `thoughtSignature` if the model has generated "thoughts" or simply as a mandatory validation field for these model versions.
2.  **Missing Interceptor in `google-api`:**
    *   While the `gemini-cli` and `antigravity` providers had dedicated logic to handle request transformation (injecting signatures), the standard `google-api` provider (used when adding a direct API Key in OpenCode) was missing this transformation logic.
    *   It was sending raw `functionCall` objects as they were structured by the AI SDK or OpenCode core, without the proprietary `thoughtSignature` field that Google's new API version demands.

## 3. Technical Solution
We implemented a **Fetch Interceptor** specifically for the `google-api` provider family in `provider.ts`.

**Mechanism:**
1.  **Interception:** The provider now intercepts every HTTP request made by `google-api` accounts before it leaves the application.
2.  **Detection:** It checks if the request URL targets the `generativelanguage.googleapis.com` endpoint.
3.  **Transformation:**
    *   It parses the JSON body of the request.
    *   It recursively scans `contents` (and wrapped `request.contents`) for any parts containing a `functionCall`.
    *   If a `functionCall` is found without an existing `thoughtSignature`, it injects a "sentinel" signature: `"skip_thought_signature_validator"`.
4.  **Forwarding:** The modified request body—now satisfying the API's validation schema—is serialized and sent to Google.

## 4. Verification
*   **Previous Behavior:** Request Body `{"functionCall": { "name": "..." }}` -> **API 400 Error**
*   **New Behavior:** Request Body `{"functionCall": { "name": "..." }, "thoughtSignature": "skip_thought_signature_validator"}` -> **API 200 OK**

This ensures that even if we don't have a real cached thought signature from a previous turn, we provide the required field to allow the API to accept the request and proceed with tool execution.
