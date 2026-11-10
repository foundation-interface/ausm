{
  "targets": [
    {
      "target_name": "selection_monitor",
      "conditions": [
        ["OS=='mac'", {
          "sources": [
            "src/mac/selection_monitor.mm",
            "src/mac/lib/clipboard.mm",
            "src/mac/lib/keyboard.mm",
            "src/mac/lib/utils.mm"
          ],
          "include_dirs": [
            "<!@(node -p \"require('node-addon-api').include\")",
            "src/mac"
          ],
          "libraries": [
            "-framework ApplicationServices",
            "-framework Carbon",
            "-framework Cocoa"
          ],
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "MACOSX_DEPLOYMENT_TARGET": "10.15",
            "OTHER_CFLAGS": [
              "-ObjC++"
            ]
          },
          "defines": [
            "NAPI_DISABLE_CPP_EXCEPTIONS"
          ]
        }]
      ]
    }
  ]
}
