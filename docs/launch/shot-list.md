# Recording shot list

Retimed against the measured warm path, not the one-second launch the original
plan assumed. That assumption is where the dead air comes from, so it is marked
explicitly below rather than discovered on the day.

## The numbers this is cut against

All measured, none derived (G1, G2, G3, and the soak).

| Moment | Measured | Source |
|---|---|---|
| `previewUrl` resolve, warm | ~255 ms cold, ~1275 ms warm | direct measurement, not subtraction |
| fork to healthy over loopback | ~1.1 s | soak ticks, five apps |
| instance ready | **~4.0 s** | G1 warm p50, Gitea |
| app in the visitor's browser | **~5.5 s** | G1 warm p50, Gitea |
| loopback health check | 281 ms | G1 |
| app's own contribution | ~0.3 s of the 5.5 s | G1 |
| p50 spread across apps | 2.9% (Gitea 5.5 s, Jaeger 5.3 s) | G1, published per app |

## The problem, stated before the shot list

**5.5 seconds is a long time on camera.** The original beats assumed roughly one
second, which made the launch a cut rather than a scene. At 5.5 s there is a real
gap between the tap and anything appearing, and it lands in exactly one place:

> **Dead air is 4.0 s to 5.5 s.** The instance is ready, the timer has taken its
> first stop, and the visitor's browser is still fetching. Nothing about the
> screen changes for a second and a half.

There is a second, smaller gap from about 1.2 s to 4.0 s, but that one is covered:
the timer is counting, pills are filling, and there is motion to watch. The 4.0 to
5.5 window is the one where the number has already stopped once.

Three ways to handle it, in order of preference:

1. **Let it run.** Do not cut. The honesty of the number is the entire point of
   the project, and a jump cut in a video about measured latency is the one edit
   that undermines the thing being demonstrated.
2. **Fill it with the second stop's own motion**: the border pulse at each stop
   and the 8 px slide of the instance link. Both already exist in the spec.
3. **Only if it truly drags:** hold on the cost receipt appearing rather than on
   the timer. Never speed-ramp the timer itself.

**Do not fake the latency in either direction.** Not a speed ramp, not a cut, not
a re-record on a warm pool that happens to be unusually fast. If the take is 6.2 s,
the take is 6.2 s.

## Shot list

Total target: **75 to 90 seconds.** Single continuous screen recording for shots
2 to 5, since cutting inside the launch is the one thing that would make the
timing unbelievable.

| # | Shot | Duration | What is on screen | Notes |
|---|---|---|---|---|
| 1 | Catalog | 0:00 to 0:06 | Five cards, category chips, the credit gauge in the corner | Let the gauge be legible for at least two seconds. It is the claim nobody else makes |
| 2 | Tap Launch | 0:06 to 0:07 | Card content replaced in place by the timer panel | No navigation, no modal. Shows the panel is the card |
| 3 | The count | 0:07 to 0:11 | Timer counting in hundredths, pills filling left to right | 4.0 s of genuine motion. `checking it answers` is a blink at 281 ms, do not slow it |
| 4 | **First stop** | 0:11 | Number stops, accent flash, label reads `ready` | The honest moment the instance became usable |
| 5 | **The gap** | 0:11 to 0:12.5 | Number resumes counting, border pulse, link slides up | **This is the dead air.** Do not cut it. See above |
| 6 | Second stop | 0:12.5 | `in your browser`, iframe fades in below the toolbar | Gitea's actual first screen, logged in |
| 7 | Use it | 0:12.5 to 0:35 | Create an issue in the seeded repo, live | The canary does exactly this every hour. Say so in the voiceover |
| 8 | Cost receipt | 0:35 to 0:45 | Receipt showing sandbox-seconds and USD for this instance | Pause here. The number is small and that is the point |
| 9 | Toolbar and countdown | 0:45 to 0:55 | 10-minute countdown, share link, kill button | Mention the three expiry layers in one line, do not enumerate them |
| 10 | Deliberate kill | 0:55 to 1:05 | Press kill, instance goes, lost-instance state appears | Show the failure state on purpose. It is the most trust-building shot in the video |
| 11 | Health wall | 1:05 to 1:20 | Five canaries, each naming what it asked | `created an issue and read it back`, not `200 OK`. This is the V70 lesson, on screen |
| 12 | Credit gauge close | 1:20 to 1:30 | Gauge with the measured-versus-modelled split visible | End on the operator's real bill |

## Voiceover beats, timed to the gaps

Write to the dead air rather than against it.

- **0:07 to 0:11**, over the count: what is actually happening, fork and health
  check. Four seconds of speech fits comfortably.
- **0:11 to 0:12.5**, over the gap: *"It is ready there. Now it has to get here."*
  One line, and it explains the exact thing the screen is not showing.
- **0:35 to 0:45**, over the receipt: the per-instance cost, then the day's total.
- **1:05 to 1:20**, over the health wall: that each check does the app's real work,
  and why a status code would not have caught the setup-wizard failure.

## Do not shoot

- Any sandbox id, `pt_token`, preview host, or the `__pt_preview` cookie. Section
  10.2 goes out before this is published, and the recording must not be the thing
  that discloses the format.
- The DevTools network pane on any preview URL, for the same reason.
- A cold launch presented as a warm one, or the reverse. Label which it is.

## Before shooting

- Warm pool primed, so the take is the p50 path and not a cold outlier.
- Soak green, so the health wall on screen is real rather than staged.
- Run the recording take twice and keep the second, not the fastest.
