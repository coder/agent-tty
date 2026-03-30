printf '\033c'
printf 'design/README.md\n================\n'
sed -n '1,35p' design/README.md
printf '\ndesign/ARCHITECTURE.md\n======================\n'
sed -n '1,45p' design/ARCHITECTURE.md
