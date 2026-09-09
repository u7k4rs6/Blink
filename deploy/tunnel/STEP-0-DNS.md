# Step 0: move utkarshbahuguna.me to Cloudflare

Self contained. Do not switch to another doc while following this.

Read the two warnings first. One of them concerns your email, which is the thing
most likely to break quietly and be noticed a week later.

---

## Decided: the old mail records go, Email Routing replaces them

Checks done, nothing depends on `@utkarshbahuguna.me` for mail. So:

- **Do not recreate** Namecheap's MX or SPF records in Cloudflare. Carrying dead
  config forward only means somebody debugs it later. They get deleted.
- **Do set up Cloudflare Email Routing** with a catch-all to
  `utkarshbahuguna10@gmail.com`. Nothing needs it today; it costs two minutes
  now, and it is the difference between owning a domain and being able to use it.

Email Routing writes its own MX and SPF records, so the zone ends up with correct
mail records rather than none.

**One thing to know about a catch-all:** every address at the domain forwards,
including ones you never created. That is convenient until the domain is scraped,
after which spam aimed at `admin@`, `info@` and the rest lands in your inbox.
Fine to start with. If it gets noisy, replace the catch-all with specific aliases
in the same screen.

**Receive only.** Email Routing forwards mail to you; it does not let you send
*from* an address at the domain. Sending needs Gmail's "Send mail as" with an
SMTP relay, which is separate and not needed for anything here.

## Warning 2: one record type must NOT be proxied

Cloudflare turns proxying on by default for A and CNAME records. For GitHub
Pages that breaks TLS: Pages terminates its own HTTPS, and proxying it puts two
certificate authorities on one hostname. The symptom is an intermittent **526
Invalid SSL certificate**, and because it is intermittent it is easy to
misdiagnose.

Pages records go **grey**. The Blink record goes **orange**, because a tunnel
only works through Cloudflare's network. That is the whole rule.

---

## The checklist

### 1. Create the account and add the zone

- [ ] Sign up at `dash.cloudflare.com` if you have no account
- [ ] **Add a site** → `utkarshbahuguna.me` → **Free** plan → Continue
- [ ] Cloudflare scans your existing DNS and shows what it found

### 2. Review what Cloudflare imported, then prune

Cloudflare scans and imports. Check it against what your zone actually holds.

**Keep these, all grey:**

| Type | Name | Value | Proxy |
|---|---|---|---|
| A | `utkarshbahuguna.me` | `185.199.108.153` | **grey** |
| A | `utkarshbahuguna.me` | `185.199.109.153` | **grey** |
| A | `utkarshbahuguna.me` | `185.199.110.153` | **grey** |
| A | `utkarshbahuguna.me` | `185.199.111.153` | **grey** |
| CNAME | `www` | `utkarshbahuguna.me` | **grey** |

- [ ] All four Pages A records present. **Add any that are missing before
      continuing**, because adding one later means an outage in between
- [ ] `www` CNAME present

**Delete these** (Namecheap forwarding, decided above, nothing depends on them):

- [ ] All five `MX` records pointing at `eforward*.registrar-servers.com`
- [ ] The `TXT` record `v=spf1 include:spf.efwd.registrar-servers.com ~all`

Delete them here, in Cloudflare, before the nameservers move. Email Routing adds
its own in step 7 and they would otherwise conflict.

### 3. Set the Pages records to grey cloud

- [ ] Click the orange cloud on each of the four apex A records until grey
- [ ] Same for the `www` CNAME
- [ ] Nothing else exists yet, so nothing else to change

Grey means Cloudflare answers the DNS query and then gets out of the way. That is
what Pages needs.

### 4. Copy the two nameservers

Cloudflare shows two, of the form `something.ns.cloudflare.com`. They are
assigned to your account, so they are not the ones in any guide.

- [ ] Write both down exactly

### 5. Change the nameservers at Namecheap

- [ ] Namecheap → **Domain List** → `utkarshbahuguna.me` → **Manage**
- [ ] **Nameservers** section → change **Namecheap BasicDNS** to **Custom DNS**
- [ ] Paste both Cloudflare nameservers, one per line
- [ ] Save (the green tick)

### 6. Wait for the zone to go active

- [ ] Cloudflare shows **Active** on the site overview, and emails you
- [ ] Verify yourself:

```sh
dig +short NS utkarshbahuguna.me
```

**Done when** it returns your two `*.ns.cloudflare.com` names instead of
`dns1.registrar-servers.com` and `dns2.registrar-servers.com`.

Usually minutes. `.me` is fast. Cloudflare says up to 24 hours because it has to
cover every registrar; yours will not take that.

### 7. Re-trigger the GitHub Pages certificate

**Do this as soon as the zone shows Active, and start it BEFORE the Email
Routing verification.** GitHub provisions the certificate in the background and
Cloudflare sends its verification email in the background, so the two waits
overlap and cost nothing extra. Doing them in sequence wastes an hour.

**Why it needs a nudge.** Moving nameservers restarts GitHub's domain
validation. Right now the site presents GitHub's default wildcard:

```
subject=CN=*.github.io
```

which does not cover `utkarshbahuguna.me`, so HTTPS fails with
`ERR_CERT_COMMON_NAME_INVALID` while plain HTTP returns 200. GitHub will notice
the DNS change eventually on its own; removing and re-adding the domain forces
it to validate now against the records Cloudflare is serving.

- [ ] Go to `u7k4rs6/u7k4rs6.github.io` → **Settings** → **Pages**
- [ ] Under **Custom domain**, clear the field → **Save**
- [ ] Re-enter `utkarshbahuguna.me` → **Save**
- [ ] GitHub shows "DNS check in progress", then a green tick

Provisioning usually takes a few minutes and can take up to an hour.

- [ ] Once the tick appears, tick **Enforce HTTPS**

`Enforce HTTPS` stays greyed out until the certificate exists. That greying is
the real progress indicator: when it becomes clickable, the certificate has
landed.

**Check:**

```sh
# Loads clean, no certificate error.
curl -sI https://utkarshbahuguna.me | head -1

# The subject is YOUR domain, not the github.io wildcard.
echo | openssl s_client -connect utkarshbahuguna.me:443 \
  -servername utkarshbahuguna.me 2>/dev/null | openssl x509 -noout -subject -issuer
```

| Check | Expected | Currently |
|---|---|---|
| `curl -sI https://` | `HTTP/2 200` | certificate error |
| certificate subject | `CN=utkarshbahuguna.me` | `CN=*.github.io` |
| Enforce HTTPS | clickable, then ticked | greyed out |

- [ ] All three pass

**If the certificate has not appeared within an hour**, work through these in
order. The first two are the usual causes.

1. **The A records are proxied.** GitHub validates by reaching the domain and
   expecting to find its own servers. An orange cloud puts Cloudflare in the way
   and validation fails with no useful message. Confirm all four apex A records
   and the `www` CNAME are **grey**, then remove and re-add the domain again.

2. **A record is missing.** `dig +short A utkarshbahuguna.me` must return all
   four `185.199.*` addresses. Three out of four can validate intermittently and
   then fail, which looks like a GitHub problem and is not.

3. **The `CNAME` file in the repo disagrees.** Re-adding the domain in Settings
   rewrites that file at the repo root; check it contains exactly
   `utkarshbahuguna.me` with no scheme, no `www`, no trailing slash.

4. **Remove and re-add once more.** A second attempt after DNS has fully settled
   often succeeds where the first, fired minutes after the nameserver change, did
   not.

5. **Check GitHub is not the problem**: `githubstatus.com`, Pages component.

**This does not block anything else.** Blink runs on `blink.utkarshbahuguna.me`,
a different hostname with its own certificate from Cloudflare, so steps 8 onward
proceed regardless. A portfolio without HTTPS is a problem worth fixing, not a
reason to stop.

### 8. Set up Email Routing

Only once the zone shows **Active**. Email Routing needs Cloudflare to be
authoritative before it can receive anything.

- [ ] Dashboard → your domain → **Email** → **Email Routing** → **Get started**
- [ ] Destination address: `utkarshbahuguna10@gmail.com` → **Send verification**
- [ ] **Check that inbox.** Cloudflare sends a verification message with a
      confirmation link. It arrives in under a minute. **Check spam if it does
      not:** a first message from a new sender to a Gmail account often lands
      there
- [ ] Click the link. The destination shows as **Verified**
- [ ] Back in Email Routing → **Routing rules** → enable **Catch-all address**
- [ ] Action: **Send to an email**, destination your verified Gmail → Save
- [ ] Accept the prompt to **add the required MX and TXT records**. Cloudflare
      writes three MX records at `*.mx.cloudflare.net` and its own SPF

Confirm the records landed:

```sh
dig +short MX utkarshbahuguna.me      # expect *.mx.cloudflare.net
dig +short TXT utkarshbahuguna.me     # expect an SPF mentioning _spf.mx.cloudflare.net
```

- [ ] Send a test message to `hello@utkarshbahuguna.me` from any account
- [ ] It arrives in your Gmail within a minute or two

### 9. Check the portfolio, immediately

Do all five. Two minutes, and it catches a TLS problem now instead of a day later.

```sh
# 1. Resolves to the Pages IPs, not a Cloudflare IP.
dig +short A utkarshbahuguna.me

# 2. Loads over HTTPS, status 200.
curl -sI https://utkarshbahuguna.me | head -1

# 3. The certificate is for your domain and not expired.
echo | openssl s_client -connect utkarshbahuguna.me:443 \
  -servername utkarshbahuguna.me 2>/dev/null | openssl x509 -noout -subject -dates

# 4. www works too.
curl -sI https://www.utkarshbahuguna.me | head -1

# 5. Mail: the test message from step 7 arrived.
```

| Check | Expected | If wrong |
|---|---|---|
| `dig A` | The four `185.199.*` addresses | A Cloudflare IP means the record is orange. Set it grey |
| `curl -sI` | `HTTP/2 200` | `526` means proxied Pages. Set it grey and wait a minute |
| certificate | subject `utkarshbahuguna.me`, valid dates | A Cloudflare-issued cert means it is proxied |
| `www` | `200` or a redirect to the apex | Check the CNAME exists and is grey |
| test email | arrives within minutes | Destination not verified, or the catch-all rule is off |

- [ ] All five pass

### 10. Only now, continue

```sh
sh deploy/tunnel/setup.sh blink.utkarshbahuguna.me
```

It checks the nameservers first and creates the `blink` record itself, proxied,
which is correct for a tunnel and the opposite of the Pages records.

---

## What breaks during the transition, and for how long

**Short answer: if step 2 is done correctly, nothing, and there is no window
where the portfolio is down.**

The reason is that a nameserver change is not a cutover. Both sets of
nameservers serve answers throughout, and every resolver gets a valid answer from
whichever it happens to ask:

| Which nameserver a resolver uses | What it returns |
|---|---|
| Still Namecheap, cached delegation | The Pages IPs. Correct |
| Already Cloudflare | The Pages IPs, imported in step 2. Correct |

Both answers are the same, so nobody sees an outage. **This is only true if the
records were imported correctly**, which is why step 2 is a checklist rather than
a glance.

**The real risk is not timing, it is a missing record.** If an MX record was not
imported, mail starts failing the moment a resolver switches, and keeps failing.
Nothing self corrects. That is the failure mode to guard against, and step 2 is
the guard.

**Timings, concretely:**

| Thing | How long |
|---|---|
| Your current record TTL | **1471 seconds**, about 25 minutes. Anything cached expires within that |
| `.me` registry delegation update | Minutes, usually under 30 |
| Cloudflare reporting Active | Minutes to a few hours |
| Worst realistic case | A few hours, still with no outage |

**During the window you may see mixed results** if you check from different
networks: your laptop might already use Cloudflare while your phone still has
Namecheap cached. Both return the same IPs, so both work. Different answers to
`dig +short NS` from different networks is propagation in progress, not a fault.

**What genuinely would break:**

| Cause | Effect | Fix |
|---|---|---|
| A Pages A record not imported | Portfolio 404s or fails to resolve for resolvers on Cloudflare | Add it. Recovers within one TTL |
| Pages records left orange | Intermittent `526` | Set grey. Recovers in about a minute |
| MX records not imported | Mail bounces silently | Add them, then test. Mail sent meanwhile is lost |
| Nameservers pasted wrong | Domain stops resolving entirely | Fix at Namecheap. Recovers within one TTL |

**Reverting** is the same operation backwards: set Namecheap back to BasicDNS and
the old records are still there. Nothing is destroyed by this change, which is
worth knowing before you start.

## Your phone test, later

Testing the Worker from mobile data is exactly right: a different network, a
different resolver, and no local cache. Two notes for when you do it.

Turn **Wi-Fi off**, not just "use the phone". iOS and Android both prefer Wi-Fi
silently, and testing over your own Wi-Fi tests the laptop's own network rather
than the outside world.

Expect **HTTP 503** on the offline page. That is deliberate: a reader sees the
page, and a machine sees an honest status. The browser will render it normally.
