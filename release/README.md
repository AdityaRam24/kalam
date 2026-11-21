# Ready-built Trinetra bundles

`trinetra-<version>-bundle.tgz` is the full install bundle: the image, the Helm chart, helm/crane, `install.sh`/`.bat`, `pcai-import.bat` and `uninstall.sh`/`.bat`. It is stored with **Git LFS** because it is larger than GitHub's 100 MB file limit.

On the machine that reaches PCAI:

```bat
git lfs install          & rem once per machine
git pull                 & rem brings the real file, not a small pointer
tar -xzf release\trinetra-0.1.0-bundle.tgz
cd trinetra-0.1.0
pcai-import.bat --registry <registry your PCAI nodes pull from>
```

If the `.tgz` is only about 130 bytes, it is still the LFS pointer. Run `git lfs pull`.

Rebuild it from source with `deploy\bundle\build-bundle.bat`, then copy `deploy\bundle\dist\trinetra-<version>-bundle.tgz` here.
