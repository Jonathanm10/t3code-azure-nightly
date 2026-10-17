import importlib.util
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("extract_app", Path(__file__).with_name("extract-app.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
APP = "T3 Code (Azure Nightly).app"


class ExtractionTests(unittest.TestCase):
    def archive(self, root, entries):
        archive = Path(root) / "fixture.zip"
        with zipfile.ZipFile(archive, "w") as bundle:
            for name, content, mode in entries:
                info = zipfile.ZipInfo(name)
                info.external_attr = mode << 16
                bundle.writestr(info, content)
        return archive

    def test_extracts_internal_framework_links(self):
        with tempfile.TemporaryDirectory() as root:
            archive = self.archive(root, [
                (f"{APP}/Contents/MacOS/app", b"fixture", stat.S_IFREG | 0o755),
                (f"{APP}/Contents/Frameworks/A/Versions/A/bin", b"fixture", stat.S_IFREG | 0o755),
                (f"{APP}/Contents/Frameworks/A/Versions/Current", b"A", stat.S_IFLNK | 0o777),
            ])
            destination = Path(root) / "out"
            module.extract_app(archive, destination)
            self.assertEqual((destination / APP / "Contents/Frameworks/A/Versions/Current/bin").read_bytes(), b"fixture")

    def test_refuses_traversal_and_symlink_descendants_before_writing(self):
        for entries in [
            [(f"{APP}/../../outside", b"no", stat.S_IFREG | 0o644)],
            [(f"{APP}/Contents/link", b"../../../outside", stat.S_IFLNK | 0o777)],
            [(f"{APP}/Contents/link", b"target", stat.S_IFLNK | 0o777), (f"{APP}/Contents/link/file", b"no", stat.S_IFREG | 0o644)],
        ]:
            with self.subTest(entries=entries), tempfile.TemporaryDirectory() as root:
                archive = self.archive(root, entries)
                destination = Path(root) / "out"
                with self.assertRaises(ValueError):
                    module.extract_app(archive, destination)
                self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
