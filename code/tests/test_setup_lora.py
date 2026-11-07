"""tools/setup_lora.py: key file handling and the settings it writes, with a fake board."""
import base64
import stat
import sys
from pathlib import Path

import pytest

pytest.importorskip("meshtastic")
from meshtastic.protobuf import channel_pb2, localonly_pb2  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import setup_lora  # noqa: E402


class FakeNode:
    """A board straight out of the box, plus one public secondary channel."""

    def __init__(self):
        self.localConfig = localonly_pb2.LocalConfig()
        self.channels = [channel_pb2.Channel(index=i) for i in range(8)]
        self.channels[1].role = channel_pb2.Channel.SECONDARY
        self.channels[1].settings.name = "LongFast"
        self.log = []

    def beginSettingsTransaction(self):
        self.log.append("begin")

    def writeConfig(self, name):
        self.log.append(("config", name))

    def writeChannel(self, i):
        self.log.append(("channel", i))

    def commitSettingsTransaction(self):
        self.log.append("commit")


def test_fresh_board_fails_then_passes_after_apply():
    ch = setup_lora.new_channel()
    node = FakeNode()
    assert not any(ok for _, ok, _ in setup_lora.check(node, ch))

    setup_lora.apply(node, ch)
    rows = setup_lora.check(node, ch)
    assert all(ok for _, ok, _ in rows), rows
    # Everything is written inside one transaction; channel 1 is switched off.
    assert node.log[0] == "begin" and node.log[-1] == "commit"
    assert {("config", "lora"), ("config", "device"), ("channel", 0), ("channel", 1)} <= set(node.log)
    assert ("channel", 2) not in node.log  # already disabled, left alone


def test_wrong_key_fails():
    node = FakeNode()
    setup_lora.apply(node, setup_lora.new_channel())
    rows = dict((n, ok) for n, ok, _ in setup_lora.check(node, setup_lora.new_channel()))
    assert not rows["channel key"]


def test_report_never_shows_the_key():
    ch = setup_lora.new_channel()
    node = FakeNode()
    setup_lora.apply(node, ch)
    text = repr(setup_lora.check(node, ch))
    assert base64.b64encode(ch["psk"]).decode() not in text
    assert ch["psk"].hex() not in text


def test_key_file_round_trip(tmp_path):
    path = tmp_path / "lora_channel.key"
    ch = setup_lora.new_channel()
    setup_lora.save(path, ch)
    assert setup_lora.load(path) == ch
    assert len(ch["name"]) <= setup_lora.NAME_MAX
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    with pytest.raises(SystemExit):  # never replace the team key by accident
        setup_lora.save(path, setup_lora.new_channel())


def test_key_file_is_git_ignored():
    assert setup_lora.git_ignored(setup_lora.KEY_FILE) in (True, None)
