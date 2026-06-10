import os

temp_dir = os.path.join(os.environ["TEMP"], "mona-python-build")
python_dir = os.path.join(temp_dir, "python")

# Get top-level directories under Lib/site-packages sorted by size
site_packages = os.path.join(python_dir, "Lib", "site-packages")

sizes = []
for entry in os.scandir(site_packages):
    if entry.is_dir():
        total = 0
        for root, dirs, files in os.walk(entry.path):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(root, f))
                except:
                    pass
        sizes.append((entry.name, total))

sizes.sort(key=lambda x: -x[1])

print("Top 30 packages by size in site-packages:")
print(f"{'Package':<45} {'Size (MB)':>10}")
print("-" * 57)
for name, size in sizes[:30]:
    print(f"{name:<45} {size / 1_048_576:>10.1f}")

total = sum(s for _, s in sizes)
print(f"\nTotal site-packages: {total / 1_048_576:.1f} MB")

# Also check python root size
root_total = 0
for root, dirs, files in os.walk(python_dir):
    for f in files:
        try:
            root_total += os.path.getsize(os.path.join(root, f))
        except:
            pass
print(f"Total python/: {root_total / 1_048_576:.1f} MB")
