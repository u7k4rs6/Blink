# Cloudflare setup

You have used Cloudflare only for DNS, so this is written from that starting
point. Two things happen here: the zone moves to Cloudflare nameservers, and a
Worker serves an offline page when the laptop is asleep.

## Why the nameservers have to move

**A named tunnel cannot work from Namecheap DNS.** Its target,
`<TUNNEL_ID>.cfargotunnel.com`, has no public DNS record at all:

```
$ dig +short A cfargotunnel.com
                      (nothing)
```

It resolves only inside Cloudflare's network. So the hostname must live in a zone
Cloudflare serves, with the record proxied. A CNAME to it from Namecheap's own
DNS points at something the public internet cannot resolve, and the hostname
simply does not exist.

This is also what makes the offline page possible: a Worker can only run on a
route in a zone Cloudflare controls.

**Your portfolio keeps working.** Moving nameservers does not change your
records, only who answers for them. Cloudflare imports what Namecheap has, and
GitHub Pages carries on serving the apex.

## Step by step

### 1. Add the zone

Cloudflare dashboard, **Add a site**, `utkarshbahuguna.me`, **Free** plan.
Cloudflare scans your existing records and shows what it found.

**Check that list before continuing.** It should include the GitHub Pages A
records for the apex (`185.199.108.153` and its three siblings) and any `www`
CNAME. If anything is missing, add it now, because these are what keep the
portfolio up.

### 2. Set the GitHub Pages records to DNS only

Click the orange cloud next to each Pages record so it turns grey.

GitHub Pages terminates its own TLS. Proxying it through Cloudflare gives you two
certificate authorities arguing about the same hostname, and the usual symptom is
an intermittent 526. Grey cloud means Cloudflare answers the DNS query and then
gets out of the way.

The `blink` record is the opposite: it **must** stay orange, because a tunnel
only works through Cloudflare's network.

### 3. Change the nameservers at Namecheap

Namecheap → Domain List → `utkarshbahuguna.me` → **Manage** → Nameservers →
**Custom DNS**, and enter the two Cloudflare gives you.

Propagation is usually minutes. Cloudflare emails when the zone is active.

**Check the portfolio still loads before continuing.** If it does not, the record
list from step 1 is wrong, and that is easier to fix now than later.

### 4. Create the tunnel

```sh
sh deploy/tunnel/setup.sh blink.utkarshbahuguna.me
```

It now checks the nameservers first and refuses with instructions if the zone is
still on Namecheap DNS, rather than creating a record that cannot resolve. With
the zone on Cloudflare it creates the proxied CNAME itself, so there is nothing
to add by hand.

### 5. Deploy the offline Worker

```sh
cd deploy/tunnel/worker
npx wrangler login
npx wrangler kv namespace create BLINK_KV     # paste the printed id into wrangler.toml
npx wrangler deploy
```

**After any change to `worker.js`, redeploy and then prove the classification,
do not read the code and assume it.** The check is one deliberate outage:

```sh
systemctl --user stop blink                     # or: kill the cloudflared pid
sleep 8
curl -sS -D - -o /tmp/off.html https://blink.utkarshbahuguna.me/ \
  | grep -iE '^HTTP|x-blink'
systemctl --user start blink
```

Expect `HTTP/2 503`, `x-blink-origin: no-origin` and `x-blink-origin-status:
530`. If `x-blink-origin` names anything else, the classifier and the page
disagree about what is wrong, which is V87 and is invisible from the visitor
side because the offline page renders correctly either way.

`wrangler.toml` routes it to `blink.utkarshbahuguna.me/*` only. The apex and
`www` are untouched and keep going straight to Pages.

### 6. Prime the cache

With Blink running, load the site once through the public hostname. The Worker
refreshes its snapshot opportunistically from live traffic, so one real visit is
enough to give the offline page real numbers instead of an empty shell.

Force it immediately if you prefer:

```sh
curl -s https://blink.utkarshbahuguna.me/offline-snapshot.json | head -c 200
```

## How the fallback behaves

| Situation | What the reader gets |
|---|---|
| Laptop up | The real site, unchanged. The Worker passes everything through |
| Laptop asleep, closed, or offline | The offline page, HTTP 503, with the cached health wall and measurements |
| Blink up but returning a 404 | The 404. That is the app answering, not an outage |
| Blink returning a 5xx | The offline page, because a tunnel with nothing behind it looks exactly like that |
| An API path while offline | JSON `503`, never HTML. An offline page with a 200 would be parsed by a caller and is worse than an error |

The offline page is cached for 60 seconds, so a reader who reloads a minute later
gets the real site once the laptop is back.

## Telling a real outage from a broken origin

Once the Worker is live, **a broken origin renders as a working offline page**.
That is a success state that looks like a success state, which is the shape of
every expensive bug in this project, so the page distinguishes the cases for you.

**The fast check, from anywhere:**

```sh
curl -sI https://blink.utkarshbahuguna.me | grep -i '^x-blink'
```

| Header value | What it means | What to do |
|---|---|---|
| *(no `x-blink` headers)* | The origin is fine. You are looking at the real site | Nothing |
| `x-blink-origin: no-origin` | Nothing is listening. The tunnel is down, `run.sh` is not running, or the laptop is asleep | Path B, and check `cloudflared tunnel info blink` |
| `x-blink-origin: timeout` | Something accepted the connection and never answered. Blink is running but wedged, thrashing on memory, or mid restart | `tail -30 /tmp/blink-run/blink.log`, then check free memory |
| `x-blink-origin: origin-502` and similar | Blink is awake and returning errors. A different problem from Blink being absent | Read the log; this is an application fault, not a hosting one |

`x-blink-origin-ms` carries how long the origin took to fail, and
`x-blink-checked` is the timestamp. A `no-origin` at 3 ms is a refused
connection; a `timeout` at 8000 ms is a hung process. Those are different
diseases with the same visible symptom.

**On the page itself**, the last line reads as ordinary status text to a
stranger and tells you the same thing:

| What the page says | Case |
|---|---|
| "The machine did not answer (checked in 4 ms)." | Nothing listening |
| "The machine answered too slowly to serve this page (waited 8000 ms)." | Hung origin |
| "The machine is awake but returned an error (status 502)." | Application fault |

A visitor reads that as part of the apology and moves on. You read it as the
diagnosis, without needing a terminal.

## Checking it without waiting for an outage

Read the copy at any time:

```
https://blink.utkarshbahuguna.me/offline-preview
```

Then simulate the real thing: stop `run.sh` and load the site. You should get the
offline page rather than a Cloudflare error, and the numbers on it should be the
ones from your last session.

**Do this once before the post goes out.** An offline page that has never been
seen is a guess, and the whole point is the case where you are not there to fix
it.
