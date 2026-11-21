# Ready-built Trinetra files

## `trinetra-0.1.0-pcai-import.tgz`: upload this to PCAI

This is the Helm chart for **PCAI → Tools & Frameworks → Import Framework**. It is about 14 KB. The image it runs, `ghcr.io/adityaram24/trinetra:0.1.0` (pinned by digest to the image in the bundle below), is on GitHub Container Registry, so PCAI needs no registry of its own. It only needs internet access to `ghcr.io`.

1. `git pull`
2. In PCAI → Import Framework, upload `release/trinetra-0.1.0-pcai-import.tgz`. Set Release Name `trinetra` (lower case), use any namespace, and tick **Debug**.
3. Keep the default values. PCAI fills in `${DOMAIN_NAME}`, and Trinetra opens at `https://trinetra.<your PCAI domain>` behind PCAI's login.

To keep Trinetra's data (inventory, knowledge base, history) across restarts, set `persistence.enabled: true` in the wizard's values box. This needs a default StorageClass, which PCAI has.

## `trinetra-0.1.0-bundle.tgz`: the full offline bundle

This holds the image, the chart, helm/crane, and `install.sh`/`.bat`, `pcai-import.bat` and `uninstall.sh`/`.bat`. It is stored with **Git LFS** because it is larger than GitHub's 100 MB file limit. Run `git lfs install` once per machine. After that, `git pull` brings the real file. If the file is only about 130 bytes, run `git lfs pull`.

## Rebuilding

1. Run `deploy\bundle\build-bundle.bat`, then copy `deploy\bundle\dist\trinetra-<version>-bundle.tgz` here.
2. Push the new image to `ghcr.io/adityaram24/trinetra:<version>` with crane, using a classic token with `write:packages`.
3. Build the import chart from `deploy/helm/trinetra` with `image.repository`, `tag` and `digest` set to that image.
