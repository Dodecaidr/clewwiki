# Payments — technical

> Owner: payments team. Source: `services/payments`.

## Contract

| Field | Type | Notes |
| --- | --- | --- |
| `amount` | integer | minor units |
| `currency` | string | ISO 4217 |

## Steps

1. Validate input.
2. Reserve funds:
   - call `Ledger.reserve`
   - on failure, return `409`

```json
{ "amount": 100, "currency": "EUR" }
```

---

Escaped \*asterisks\* and a literal 1\. at line start.
