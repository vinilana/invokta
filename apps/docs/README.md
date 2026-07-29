# Invokta documentation site

The public Invokta documentation is an isolated Astro and Starlight application.
Keeping it under `apps/docs` allows documentation changes to ship with the code
they describe while keeping site dependencies out of the framework packages.

## Local development

```sh
cd apps/docs
yarn install --frozen-lockfile
yarn dev
```

## Validation

```sh
cd apps/docs
yarn validate
```

The build output is static and written to `apps/docs/dist`.

Canonical URLs default to `https://docs.invokta.dev`. Set `DOCS_SITE_URL` during
the build to use another deployment origin.
