# Invariants

- The dialog stream has one visible canvas.
- Every visible content unit is representable as a card.
- All output content remains cards on the canvas; removing redundant bubble containers must not change the basic composition of user, assistant, tool, result, error, or metadata cards.
- Tool call cards are independent card boundaries; this plan does not require unified expansion behavior or shared internal content structure across tools.
- Live operation state has one visible surface: the turn status line.
- Frontend layout flattening does not mutate backend message/session semantics.
- Message/part IDs remain stable across rendering refactors.
- Container removal must preserve existing card width, spacing, internal padding, and scroll ownership unless a specific visual change is separately approved.
