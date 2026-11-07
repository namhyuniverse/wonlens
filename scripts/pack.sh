#!/bin/sh
# 확장에 필요한 파일만 dist/wonlens.zip 으로 묶는다. 압축을 풀면 wonlens/ 폴더 하나가 나온다.
set -eu
cd "$(dirname "$0")/.."

rm -rf dist
mkdir -p dist/wonlens
cp -R manifest.json LICENSE src popup icons dist/wonlens/
(cd dist && zip -qr wonlens.zip wonlens)
rm -rf dist/wonlens
echo "dist/wonlens.zip ($(jq -r .version manifest.json))"
