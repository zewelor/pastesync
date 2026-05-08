docker_build:
  docker compose build --no-cache

test_dockerignore:
  rsync -avn . /dev/shm --exclude-from .dockerignore
