# examples/blink

Fork a Solari snapshot, wait for the app inside it to answer, hand out a preview
URL, and destroy it. This is the core of [Blink](https://github.com/) reduced to
one file.

```bash
export SOLARI_API_KEY=slr_live_...
node fork-and-serve.ts snap_your_snapshot_id 3000 /api/healthz
```

Node 22 or newer, which runs TypeScript directly with no build step.

## What it does

```
fork snapshot  ->  poll health over loopback  ->  previewUrl  ->  wait  ->  kill
```

A fork of a seeded snapshot reaches a usable app in about a second, measured, and
the preview URL resolves in roughly 250 ms more.

## Four things worth copying

Each of these cost a real bug to learn, and each is commented in the source.

**Record the sandbox before you create it.** A create that times out can still
have created a sandbox whose id you never receive. If the only record is the
return value, a network blip leaves a machine billing that nothing knows about.

**Poll from outside, in short calls.** A long loop inside a single `exec` hits
the gateway's duration limit and returns a bare `exec failed` that says nothing
about duration. It looks like your command broke. It did not.

**A health check is not proof the app works.** `GET / -> 200` proves a process is
listening. An app sitting in its own installer or database setup wizard answers
200 happily while refusing every real request, so a status-code check can stay
green against something completely unusable. If the app has a real interface,
exercise it.

**The query string is the credential.** `previewUrl` returns a capability URL
carrying a `pt_token`. Never log it or let it be indexed. And never build a
sub-URL with `new URL(path, previewUrl)`: that is correct behaviour everywhere
else, but here it silently drops the token and you get a 401 on the second
request while the first worked. A browser hides this by keeping the cookie the
first response sets; a script has no cookie jar, so it only breaks in exactly the
tools you point at a preview URL, such as health checks and CI.

## Two smaller traps

`previewUrl` returns an object, not a string. Interpolating it into a template
literal prints `[object Object]`.

A sandbox id decodes without a key to a host pool identifier, an internal VM id,
your org id and a creation timestamp. It is in the path of every request, so it
lands in access logs and traces by default. This example prints that a sandbox
was killed rather than which one, and only prints the id when a kill fails and a
human has to go and find it.

## Kill on every exit path

`cleanup()` runs on success, on failure, on `SIGINT` and on `SIGTERM`. A leaked
sandbox is not a bug you see in a test run. It is a bill that arrives later.

## What is deliberately missing

No retries, no warm pool, no queue, no budget ceiling. Those are the difference
between an example and a service, and they belong in your own code rather than
being implied by this one.
