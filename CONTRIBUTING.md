# Contributing to the OCT Storefront

Thanks for helping. The storefront is the catalog and installer of OpenShift
Community Tools (OCT), a community project that is not officially supported by
Red Hat. There are two kinds of contributions:

1. **Adding or updating your extension in the catalog** (most common).
2. **Changing the storefront itself** (plugin UI under `src/`, the
   `catalog-service/` Go service, scripts).

For larger changes, open an issue first so we can agree on the approach.

## Setup

Requirements: Node.js 20, Corepack (it provides the Yarn version pinned in
`package.json`), Python 3 with PyYAML and `skopeo` for the catalog checks, and Go
(version in `catalog-service/go.mod`) for the catalog service.

```bash
corepack enable
yarn install
yarn verify                    # type check, translation keys, repository rules, production build
scripts/validate-catalog.sh    # catalog consistency, including that every listed image tag is public
cd catalog-service && go vet ./... && go test ./...
```

The same checks run in GitHub Actions on every pull request. A pull request
can be merged when they pass and a maintainer has reviewed it.

## Adding your extension to the catalog

Start from [docs/extension-template/](docs/extension-template/) and follow the
checklist in [docs/extension-standard.md](docs/extension-standard.md). In short:

- Your extension lives in its own repository, named `oct-<name>`.
- **Images must be public** and tagged `<semver>-ocp<major.minor>`. Publish both
  OpenShift minors (`-ocp4.22` and `-ocp4.21`) and list those exact tags in
  `spec.versions[].image`. Community **Add** has no pull secret: a private or
  missing tag installs a plugin that never becomes Ready.
- Add one `versions` row per OpenShift minor to `catalog/community.yaml`.
  `spec.href` must match a route in your `console-extensions.json`.
- If Add needs more than Namespace/Deployment/Service/ConsolePlugin (PVCs, RBAC,
  sidecars), put the complete YAML in `catalog/deploy/oct-<name>.yaml` and
  register it in `BUNDLED_DEPLOY`. Omit `storageClassName` so the cluster default
  (or the user's choice at Add) is used.
- Tile icons must be your own original artwork: add the SVG to
  `src/assets/tiles/`, register it in `src/utils/tile-icons.ts` and set `spec.icon`.
- Run `scripts/validate-catalog.sh` before opening the pull request.

## Changing the storefront

Build your image and push it to a registry you own (public, or add a pull secret):

```bash
podman build -t quay.io/<you>/oct-storefront:dev -f Containerfile .
podman push quay.io/<you>/oct-storefront:dev
```

On a lab cluster with the storefront installed, swap in your image:

```bash
oc set image deploy/oct-storefront -n oct-storefront plugin=quay.io/<you>/oct-storefront:dev
```

or deploy `deploy/install.yaml` with your image (`sed 's|quay.io/openshift-community-tools/oct-storefront:[^ ]*|quay.io/<you>/oct-storefront:dev|' deploy/install.yaml | oc apply -f -`).

**Catalog service** (`catalog-service/`): build it with
`podman build -t quay.io/<you>/oct-storefront-catalog:dev -f catalog-service/Containerfile catalog-service/`
and swap it with `oc set image deploy/catalog-service -n oct-storefront catalog-service=quay.io/<you>/oct-storefront-catalog:dev`.

The storefront is at **Community Tools** in the console. After pushing a new
`:dev` image, restart the pod (`oc rollout restart deploy/oct-storefront -n oct-storefront`)
and reload the console.

Not able to test on a cluster? Say so in the pull request and describe what you
checked instead. A maintainer tests it before the release.

## Rules

- **PatternFly 6** components only. Do not import PatternFly CSS; the console provides it.
- **Translations:** every UI string goes through `t('...')` and has an entry in
  `locales/en/plugin__oct-storefront.json`. `yarn check-i18n --fix` adds missing ones.
- **No environment-specific values:** no hostnames, IPs, StorageClasses, cluster
  URLs or tokens in code, catalog entries or docs.
- **Add and Update apply manifests with the signed-in user's credentials.** Do not
  give the storefront or the catalog service broader cluster permissions.
- **Security:** declare what an extension needs in `spec.security`, keep RBAC
  minimal, and use `backend-security-kit` for backends. See
  [docs/security-model.md](docs/security-model.md) and the Security section of
  [docs/extension-standard.md](docs/extension-standard.md). Report vulnerabilities
  privately ([SECURITY.md](SECURITY.md)), not in public issues.
- **Stats fail open:** download counts and ratings must never block browsing or installing.
- **Wording:** this is a community project; do not describe it as official Red Hat software.
- [AGENTS.md](AGENTS.md) describes the design in detail. It is also the guide
  for AI coding assistants, which are welcome; please review what they produce.

## Releases (maintainers)

Leave these to the maintainers. Do not change them in a pull request:

- the storefront version in `package.json` (both places), `src/utils/catalog-types.ts`,
  README, AGENTS.md, `deploy/install.yaml` and `deploy/upgrade.yaml`
- the storefront's own catalog rows (self rows) and `scripts/gen-upgrade-yaml.py` output
- storefront and catalog-service images (`<version>-ocp4.22` and `-ocp4.21`;
  published tags are never overwritten) and git tags

Catalog rows for your own extension's new versions are welcome in pull requests,
once their images are public.

## License

By contributing you agree that your contribution is licensed under the
[Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0), the license of this project.
