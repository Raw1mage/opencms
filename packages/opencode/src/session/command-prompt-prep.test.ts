import { describe, expect, it } from "bun:test"
import { Command } from "../command"
import { Session } from "."
import { prepareCommandPrompt } from "./command-prompt-prep"

describe("prepareCommandPrompt", () => {
  it("registers builtin /plan command as canonical planner entry", async () => {
    const command = await Command.get("plan")
    expect(command).toBeDefined()
    expect(command?.name).toBe("plan")
    expect(command?.description).toContain("planner")
    const template = await command?.template
    expect(template).toContain("plan mode")
  })

  it("prefers session.execution for subtask user model when no explicit input model is provided", async () => {
    const session = await Session.createNext({
      id: "session_command_prompt_execution",
      title: "command prompt execution",
      directory: "/tmp",
    })

    await Session.pinExecutionIdentity({
      sessionID: session.id,
      model: {
        providerId: "openai",
        modelID: "gpt-5.4",
        accountId: "openai-subscription-pincyluo-gmail-com",
      },
    })

    const result = await prepareCommandPrompt({
      commandInfo: {
        name: "test-command",
        description: "test subtask",
        subtask: true,
      } as any,
      commandName: "test-command",
      sessionID: session.id,
      inputAgent: "coding",
      template: "Run delegated task",
      resolvePromptParts: async (template) => [{ type: "text", text: template }],
    })

    const subtask = result.parts.find((part: any) => part.type === "subtask")
    expect(subtask?.model).toEqual({
      providerId: "openai",
      modelID: "gpt-5.4",
      accountId: "openai-subscription-pincyluo-gmail-com",
    })
    expect(result.userModel).toEqual({
      providerId: "openai",
      modelID: "gpt-5.4",
      accountId: "openai-subscription-pincyluo-gmail-com",
    })
  })
})
