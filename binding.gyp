{
  "variables": {
    "deps_root": "<(module_root_dir)/vendor/build-deps/install"
  },
  "targets": [
    {
      "target_name": "fast_leiden",
      "sources": [
        "native/binding.cc"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "<(deps_root)/include",
        "<(deps_root)/include/libleidenalg"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "cflags_cc": ["-std=c++17", "-fexceptions"],
      "conditions": [
        ["OS=='mac'", {
          "libraries": [
            "<(deps_root)/lib/liblibleidenalg.a",
            "<(deps_root)/lib/libigraph.a"
          ],
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LIBRARY": "libc++",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            "OTHER_CFLAGS": ["-fexceptions"]
          }
        }],
        ["OS=='linux'", {
          "libraries": [
            "<(deps_root)/lib/liblibleidenalg.a",
            "<(deps_root)/lib/libigraph.a"
          ],
          "ldflags": ["-Wl,--exclude-libs,ALL"]
        }],
        ["OS=='win'", {
          "libraries": [
            "<(deps_root)/lib/libleidenalg.lib",
            "<(deps_root)/lib/igraph.lib"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": ["/std:c++17", "/EHsc"],
              # Force /MT (static CRT) on binding.obj so it matches the
              # static-CRT build of igraph/libleidenalg in build-deps.mjs.
              # Node.js was built with /MT, and node-gyp's default tracks
              # that, but we pin it here so a future node-gyp default
              # flip (or a Visual Studio policy change) can't silently
              # reintroduce the LNK2038 RuntimeLibrary mismatch.
              "RuntimeLibrary": "0"
            }
          }
        }]
      ]
    }
  ]
}
