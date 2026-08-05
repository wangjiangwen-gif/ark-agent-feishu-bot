import os

from arkagent.paths import get_arkagent_paths


def test_arkagent_paths_use_a_stable_user_level_override():
    paths = get_arkagent_paths({"ARKAGENT_HOME": "./tmp/arkagent-home"})
    expected = os.path.abspath("./tmp/arkagent-home")
    assert paths.state_dir == expected
    assert paths.config_path == os.path.join(expected, "config.env")
    assert paths.database_path == os.path.join(expected, "gateway.db")


def test_arkagent_paths_default_to_home_directory():
    paths = get_arkagent_paths({})
    assert paths.state_dir == os.path.join(os.path.expanduser("~"), ".arkagent")
