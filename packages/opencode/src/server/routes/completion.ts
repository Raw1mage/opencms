import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import { Completion } from "../../session/completion"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

export const CompletionRoutes = lazy(() =>
  new Hono().post(
    "/",
    describeRoute({
      summary: "Stateless one-shot completion",
      description:
        "Run a single stateless LLM completion. Persists nothing — no session, message, or part storage and no session-level Bus events.",
      operationId: "completion.run",
      responses: {
        200: {
          description: "Completion result parts",
          content: {
            "application/json": {
              schema: resolver(Completion.Response),
            },
          },
        },
        ...errors(400, 429, 500, 502),
      },
    }),
    validator("json", Completion.Input),
    async (c) => {
      const body = c.req.valid("json")
      try {
        const result = await Completion.run(body)
        return c.json(result, 200)
      } catch (e) {
        if (e instanceof Completion.CompletionError) {
          const httpStatus =
            e.code === "BAD_REQUEST"
              ? 400
              : e.code === "MODEL_NOT_FOUND"
                ? 400
                : e.code === "RATE_LIMITED"
                  ? 429
                  : e.code === "PROVIDER_ERROR"
                    ? 502
                    : 500
          return c.json({ code: e.code, message: e.message }, httpStatus)
        }
        return c.json(
          { code: "DAEMON_ERROR" as const, message: e instanceof Error ? e.message : String(e) },
          500,
        )
      }
    },
  ),
)
