#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

install_wrapper() {
  host=$1
  component=$2
  wrapper="ha-deploy-$component"
  scp "$ROOT/releases/deploy/$wrapper" "$host:/tmp/$wrapper"
  scp "$ROOT/releases/deploy/$wrapper.sudoers" "$host:/tmp/$wrapper.sudoers"
  ssh -t "$host" "sudo visudo -cf /tmp/$wrapper.sudoers && sudo install -o root -g root -m 0755 /tmp/$wrapper /usr/local/sbin/$wrapper && sudo install -o root -g root -m 0440 /tmp/$wrapper.sudoers /etc/sudoers.d/$wrapper && rm -f /tmp/$wrapper /tmp/$wrapper.sudoers"
  ssh "$host" "sudo -n -l | grep -F /usr/local/sbin/$wrapper >/dev/null"
  echo "Wrapper $wrapper instalado en $host"
}

install_wrapper ha-server server
install_wrapper ha-satellite satellite
