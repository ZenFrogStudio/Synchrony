# The Synchrony landing page

Plain HTML and CSS. No build step, no dependencies, no JavaScript.

## Preview locally

Open `site/index.html` in a browser. There is nothing to install and nothing to
build. Every path on the page is relative, so it works the same double-clicked
as it does deployed.

## Deploy

Cloudflare Pages, connected to this GitHub repo:

| | |
|---|---|
| Framework preset | None |
| Build command | *(empty)* |
| Build output directory | `site` |
| Root directory | `/` |

`_headers` is read by Cloudflare Pages and sets a strict Content-Security-Policy.
The page loads no scripts and nothing off-origin, so if something ever needs an
inline `<style>` or `<script>`, change the markup rather than the policy.

## The screenshots

`img/manager.png` and `img/tasks.png` are the only screenshots in the repo, and
**both are redacted.** The working-directory path and the rolling seven-day cost
figure are blurred out of `img/manager.png`.

The unblurred originals stay out of git — `.gitignore` keeps
`media/screenshots.png` and `media/screenshots-2.png` untracked, because a raw
capture shows a real filesystem path and a real spend figure. Anyone taking a
fresh capture blurs both before copying it into `img/`.
