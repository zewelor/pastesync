up:
  docker compose run --rm --service-ports pastesync

docker_build:
  docker compose build --no-cache

# Use Docker's own context filtering so `!` rules are evaluated correctly.
show_dockerignore:
  #!/bin/sh
  set -eu
  LC_ALL=C
  export LC_ALL

  test_dir="$(mktemp -d)"
  trap 'rm -rf "$test_dir"' 0 1 2 3 15
  mkdir -p "$test_dir/context"

  docker build --file - --progress=quiet --output "type=local,dest=$test_dir/context" . >/dev/null <<-'EOF'
  # syntax=docker/dockerfile:1
  #check=skip=CopyIgnoredFile
  FROM scratch
  COPY . /context
  EOF

  find "$test_dir/context/context" \( -type f -o -type l \) -print |
    sed "s#^$test_dir/context/context/##" |
    sort > "$test_dir/included"

  cat "$test_dir/included"
  printf '\n%s\n' '---'
  printf 'Total files:\t%s\n' "$(wc -l < "$test_dir/included" | awk '{print $1}')"
  printf 'Total size:\t%s\n' "$(du -sh "$test_dir/context/context" | awk '{print $1}')"


setup:
  pre-commit install
