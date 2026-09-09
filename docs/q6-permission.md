# Q6: permission for anonymous public visitors on one operator key

**Status: RESOLVED, granted. 2026-09-10.**

Q6 asked whether Solari's terms permit what Blink does: anonymous, unauthenticated
members of the public creating sandboxes on the operator's own API key. The terms
at getsolari.com/terms never address it either way, and forbid unauthorised
redistribution or sublicensing (V44), so this needed an answer from Solari rather
than a reading. It was the top pre-launch blocker and public launches were
disabled while it was outstanding.

## The answer

Granted in writing by **Harry** at Solari on **2026-09-10**, by LinkedIn DM:
the use case is permitted on the Starter plan, with an explicit instruction to
reactivate launch functionality.

> Received by LinkedIn DM, 2026-09-10, from Harry at Solari. Quoted exactly as
> sent, including the sign off, because a permission grant is the one kind of
> record that must not be paraphrased.
>
> Hi Utkarsh,
>
> Thank you for reaching out and for your transparency regarding the use of your Solari sandbox access.
>
> Yes, your proposed use case is permitted on the Starter plan. We appreciate you taking the time to outline the safeguards you've implemented, such as the ten-minute lifetime, spend ceilings, and monitoring.
>
> Please feel free to proceed with reactivating the launch functionality. Let us know if you have any further questions.
>
> Best regards,
>
> Harry

**Note on scope.** The reply approves "your proposed use case", and the case as
proposed is the one set out in the request: five open source apps, ten minute
lifetimes, a hard spend ceiling, two concurrent sandboxes, the CPU sampler, and
Turnstile in front of the launch button. The request also disclosed, in writing
and before the answer, that outbound egress cannot be restricted (V57) and that
Turnstile had been inactive while the site was reachable. Nothing here approves
a different arrangement, and materially widening the deployment means asking
again rather than reasoning from this message.

## What this changes

- Public launches may be enabled. They stayed off from 2026-09-09 until the
  answer arrived, and the site ran with the catalog, health wall and canary log
  live and the launch endpoint refusing with 503.
- The **bring your own key** fallback stops being a live contingency. It remains
  documented as a designed alternative in `01-prd.md`, because the design is
  sound and the decision to keep it in reserve was deliberate, but it is no
  longer the plan if the answer had been no.
- The disclosure note in `01-prd.md` section 10.2 now goes as a follow up on an
  existing thread with a named person rather than as a cold approach.

## What it does not change

The permission covers the arrangement as described: ten minute lifetimes, a hard
spend ceiling, two concurrent sandboxes, the CPU sampler, and Turnstile in front
of the launch button. It is not a licence to remove those. Outbound egress
remains unrestrictable (V57), which was disclosed in the request rather than
discovered afterwards.
