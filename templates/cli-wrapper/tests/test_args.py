from app.args import build_args


def test_minimal():
    assert build_args("in.bin") == ["in.bin"]


def test_output_and_verbose():
    assert build_args("in.bin", "out.pkg", verbose=True) == ["in.bin", "-o", "out.pkg", "--verbose"]
