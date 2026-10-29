"""Building the wrapped tool's command line. Pure functions: this is where Qwen adds the
real arguments once it knows the tool (paste the tool's --help into the chat). Keeping it
free of Qt means every option can be unit-tested."""
from __future__ import annotations


def build_args(input_path: str, output_path: str = "", verbose: bool = False) -> list[str]:
    """The argument list after the tool executable. Adjust to the real tool's interface."""
    args = [input_path]
    if output_path:
        args += ["-o", output_path]
    if verbose:
        args.append("--verbose")
    return args
