# Atlas3 for chi-tools.uc.edu: the prebuilt Atlas3 dist (build.sh runs the npm
# build on the build machine) served as static files under /atlas/.
# No RUN steps, so the multi-arch legs need no emulation.
FROM docker.io/library/nginx:1.30-alpine@sha256:583b7f2fce1cdb8da5ad5c39ebd3c33b98b87d493190e548bdee1fa8c619c311

ARG VERSION=dev
ARG ATLAS_REVISION=unknown
ARG REVISION=unknown
ARG CREATED
LABEL org.opencontainers.image.title="Atlas3 (CHI)" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.source="https://github.com/robireton/Atlas3" \
      edu.uc.chi.atlas3.revision="${ATLAS_REVISION}"

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY dist/ /usr/share/nginx/html/atlas/
# CHI settings: WebAPI on the same host, sign-in through CHI auth, no plugins.
COPY config-local.json /usr/share/nginx/html/atlas/config-local.json
COPY plugins.json /usr/share/nginx/html/atlas/config/plugins.json
