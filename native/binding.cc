// fast-leiden — native addon entry point.
//
// At this stage the binding exposes a single `version()` function so we can
// confirm that the build pipeline (node-gyp -> Node.js require) is wired up
// end-to-end. The igraph / leidenalg integration is introduced in subsequent
// steps of the roadmap (see CLAUDE.md).

#include <napi.h>

namespace {

constexpr const char* kAddonVersion = "0.0.0-dev";

Napi::Value Version(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), kAddonVersion);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("version", Napi::Function::New(env, Version));
  return exports;
}

}  // namespace

NODE_API_MODULE(fast_leiden, Init)
