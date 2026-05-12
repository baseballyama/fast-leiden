{
  "targets": [
    {
      "target_name": "fast_leiden",
      "sources": [
        "native/binding.cc"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "cflags_cc": ["-std=c++17"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "NO",
        "CLANG_CXX_LIBRARY": "libc++",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "MACOSX_DEPLOYMENT_TARGET": "11.0"
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 0,
          "AdditionalOptions": ["/std:c++17"]
        }
      }
    }
  ]
}
