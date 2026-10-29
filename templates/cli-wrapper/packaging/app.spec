# PyInstaller one-file spec. Build from the project root with: pyinstaller packaging/app.spec
a = Analysis(['../app/main.py'], pathex=['..'])
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, a.binaries, a.datas, [], name='MyToolGui', console=False, upx=False)
