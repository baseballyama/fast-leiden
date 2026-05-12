// fast-leiden — native binding.
//
// Exposes five N-API functions:
//
//   - version():                  addon version string (smoke test)
//   - leidenFromEdgeList():       sync edge-list entry point
//   - leidenFromCsr():            sync CSR entry point
//   - leidenFromEdgeListAsync():  same, but runs on a worker thread,
//                                 returns a Promise
//   - leidenFromCsrAsync():       same for CSR
//
// All four leiden* functions accept the same options object on the JS side
// and return (resolve to) { membership: Uint32Array, quality: number,
// iterations: number }.

#include <napi.h>

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

#include <igraph/igraph.h>
#include <CPMVertexPartition.h>
#include <GraphHelper.h>
#include <ModularityVertexPartition.h>
#include <Optimiser.h>

// Generated from package.json by scripts/write-version-header.mjs so the
// native version stays in lock-step with the npm package version.
#include "version_generated.h"

namespace {

constexpr const char* kAddonVersion = FAST_LEIDEN_VERSION;

// ---------------------------------------------------------------------------
// Small RAII helpers.

class IgraphGuard {
 public:
  explicit IgraphGuard(igraph_t* g) : g_(g) {}
  ~IgraphGuard() {
    if (g_) igraph_destroy(g_);
  }
  IgraphGuard(const IgraphGuard&) = delete;
  IgraphGuard& operator=(const IgraphGuard&) = delete;

 private:
  igraph_t* g_;
};

class IgraphVectorIntGuard {
 public:
  explicit IgraphVectorIntGuard(igraph_vector_int_t* v) : v_(v) {}
  ~IgraphVectorIntGuard() {
    if (v_) igraph_vector_int_destroy(v_);
  }
  IgraphVectorIntGuard(const IgraphVectorIntGuard&) = delete;
  IgraphVectorIntGuard& operator=(const IgraphVectorIntGuard&) = delete;

 private:
  igraph_vector_int_t* v_;
};

// ---------------------------------------------------------------------------
// Owned representation of a Leiden call. Holds copies of all input arrays so
// that worker threads can safely operate on them after the JS call returns.

struct LeidenJob {
  uint32_t node_count = 0;
  std::vector<uint32_t> sources;
  std::vector<uint32_t> targets;
  std::vector<double> weights;
  bool has_weights = false;

  // Options.
  std::string quality_function = "modularity";
  double resolution = 1.0;
  int max_iterations = 10;
  bool has_seed = false;
  uint32_t seed = 0;
  bool directed = false;
};

struct LeidenResultC {
  std::vector<size_t> membership;
  double quality = 0.0;
  int iterations = 0;
};

// ---------------------------------------------------------------------------
// Pure C++ work — no Napi access. Safe to call from a worker thread.

void BuildIgraphFromEdges(igraph_t* g,
                          uint32_t node_count,
                          const uint32_t* sources,
                          const uint32_t* targets,
                          size_t edge_count,
                          bool directed) {
  igraph_vector_int_t edges;
  if (igraph_vector_int_init(&edges, static_cast<igraph_int_t>(2 * edge_count)) !=
      IGRAPH_SUCCESS) {
    throw std::runtime_error("igraph_vector_int_init failed");
  }
  IgraphVectorIntGuard edges_guard(&edges);

  for (size_t i = 0; i < edge_count; ++i) {
    if (sources[i] >= node_count || targets[i] >= node_count) {
      throw std::runtime_error("edge endpoint is out of range [0, nodeCount)");
    }
    VECTOR(edges)[2 * i] = static_cast<igraph_int_t>(sources[i]);
    VECTOR(edges)[2 * i + 1] = static_cast<igraph_int_t>(targets[i]);
  }

  if (igraph_create(g, &edges, static_cast<igraph_int_t>(node_count),
                    directed ? IGRAPH_DIRECTED : IGRAPH_UNDIRECTED) !=
      IGRAPH_SUCCESS) {
    throw std::runtime_error("igraph_create failed");
  }
}

LeidenResultC RunLeidenOnGraph(Graph& graph, const LeidenJob& job) {
  std::unique_ptr<MutableVertexPartition> partition;
  if (job.quality_function == "modularity") {
    partition.reset(new ModularityVertexPartition(&graph));
  } else if (job.quality_function == "cpm") {
    partition.reset(new CPMVertexPartition(&graph, job.resolution));
  } else {
    throw std::runtime_error("unknown qualityFunction: " + job.quality_function);
  }

  Optimiser optimiser;
  if (job.has_seed) {
    optimiser.set_rng_seed(static_cast<size_t>(job.seed));
  }

  // The Leiden algorithm in libleidenalg is itself iterative inside one
  // optimise_partition() call; the outer loop here mirrors leidenalg's
  // Python `n_iterations` parameter — re-running optimise_partition often
  // squeezes out another improvement, until it returns 0 (converged).
  int iterations_run = 0;
  for (int i = 0; i < job.max_iterations; ++i) {
    double improvement = optimiser.optimise_partition(partition.get());
    ++iterations_run;
    if (improvement <= 0.0) break;
  }

  return LeidenResultC{
      partition->membership(),
      partition->quality(),
      iterations_run,
  };
}

// Global mutex serializing every call into igraph + libleidenalg.
//
// Why a process-global lock: igraph's error-handling layer is explicitly
// *not* thread-safe — see vendor/igraph/include/igraph_error.h (the
// IGRAPH_ERROR family relies on thread-shared error state). libleidenalg
// builds on top of those calls. If we let two libuv worker threads run
// optimise_partition() simultaneously, we risk torn error state, partial
// cleanup on one thread observed by the other, and undefined behaviour.
//
// Holding this lock for the full RunLeidenJob serializes sync calls, async
// workers, and any mix of the two. Sync callers may briefly block waiting
// for an in-flight async worker — that's the price of correctness given the
// upstream constraint. If contention is ever a real problem, the right
// answer is process isolation (worker_threads / child_process), not a
// finer-grained lock.
std::mutex g_leiden_mutex;

LeidenResultC RunLeidenJob(const LeidenJob& job) {
  std::lock_guard<std::mutex> lock(g_leiden_mutex);

  const size_t edge_count = job.sources.size();
  igraph_t g;
  BuildIgraphFromEdges(&g, job.node_count, job.sources.data(), job.targets.data(),
                       edge_count, job.directed);
  IgraphGuard g_guard(&g);

  std::unique_ptr<Graph> graph(
      job.has_weights ? Graph::GraphFromEdgeWeights(&g, job.weights) : new Graph(&g));
  return RunLeidenOnGraph(*graph, job);
}

// ---------------------------------------------------------------------------
// JS -> LeidenJob conversion. Validates and copies TypedArrays into vectors
// owned by the job so we can hand them off to a worker thread safely.

// Defence in depth: TS already rejects NaN / Infinity / negative weights, but
// bypassing the public API must not silently produce a quality=NaN result or
// pass negative weights into modularity / CPM (both are defined over the
// non-negative reals in libleidenalg's implementation).
bool ValidateWeights(Napi::Env env, const double* data, size_t n) {
  for (size_t i = 0; i < n; ++i) {
    if (!std::isfinite(data[i])) {
      Napi::RangeError::New(env, "weights[i] must be finite")
          .ThrowAsJavaScriptException();
      return false;
    }
    if (data[i] < 0.0) {
      Napi::RangeError::New(env, "weights[i] must be non-negative")
          .ThrowAsJavaScriptException();
      return false;
    }
  }
  return true;
}

// Defence in depth: IsTypedArray() returns true for Uint8Array / Float32Array /
// any other view, but As<Napi::Uint32Array>() is an unchecked cast — calling
// .Data() on a mismatched view aliases the underlying buffer at the wrong
// stride and silently reads garbage (or walks off the end). Check the actual
// element type before we trust the cast.
bool IsExactlyUint32Array(Napi::Value v) {
  return v.IsTypedArray() &&
         v.As<Napi::TypedArray>().TypedArrayType() == napi_uint32_array;
}

bool IsExactlyFloat64Array(Napi::Value v) {
  return v.IsTypedArray() &&
         v.As<Napi::TypedArray>().TypedArrayType() == napi_float64_array;
}

// Defence in depth: Uint32Value() silently coerces 1.5 → 1, -1 → 4294967295,
// and NaN → 0. Any of those can corrupt downstream sizing (e.g. a "huge"
// nodeCount triggers an OOM allocation, a 0 walks past the bounds check
// without reporting it). Reject anything that isn't a clean integer in range.
bool ReadNodeCount(Napi::Env env, Napi::Object& input, uint32_t& out) {
  Napi::Value v = input.Get("nodeCount");
  if (!v.IsNumber()) {
    Napi::TypeError::New(env, "nodeCount must be a number")
        .ThrowAsJavaScriptException();
    return false;
  }
  double raw = v.As<Napi::Number>().DoubleValue();
  if (!std::isfinite(raw) || raw < 0.0 || raw > 4294967295.0 ||
      raw != std::floor(raw)) {
    Napi::RangeError::New(env, "nodeCount must be an integer in [0, 2^32)")
        .ThrowAsJavaScriptException();
    return false;
  }
  out = static_cast<uint32_t>(raw);
  return true;
}

// Returns true on success. On failure, raises a JS exception and returns false
// so the caller can short-circuit (consistent with ReadEdgeListJob / ReadCsrJob).
bool ApplyOptions(Napi::Env env, Napi::Object& obj, LeidenJob& job) {
  Napi::Value q = obj.Get("qualityFunction");
  if (q.IsString()) {
    job.quality_function = q.As<Napi::String>().Utf8Value();
  }
  Napi::Value res = obj.Get("resolution");
  if (res.IsNumber()) {
    // Defence in depth: DoubleValue() happily returns NaN here, which would
    // propagate through libleidenalg and surface as a quality=NaN result.
    // TS already rejects this, but the native layer must not be the weak link.
    double raw = res.As<Napi::Number>().DoubleValue();
    if (!std::isfinite(raw) || raw < 0.0) {
      Napi::RangeError::New(env, "resolution must be a non-negative finite number")
          .ThrowAsJavaScriptException();
      return false;
    }
    job.resolution = raw;
  }
  Napi::Value mi = obj.Get("maxIterations");
  if (mi.IsNumber()) {
    // Defence in depth: Int32Value() silently floors 1.5 → 1 and turns NaN
    // into 0, which would skip the optimisation loop entirely and return an
    // un-improved partition with iterations: 0.
    double raw = mi.As<Napi::Number>().DoubleValue();
    if (!std::isfinite(raw) || raw < 1.0 || raw > 2147483647.0 ||
        raw != std::floor(raw)) {
      Napi::RangeError::New(env, "maxIterations must be a positive integer")
          .ThrowAsJavaScriptException();
      return false;
    }
    job.max_iterations = static_cast<int>(raw);
  }
  Napi::Value seed = obj.Get("seed");
  if (seed.IsNumber()) {
    // Defence in depth: the TS layer already constrains this, but Uint32Value()
    // would silently coerce e.g. -1 or NaN into surprising values. Reject any
    // non-integer or out-of-range seed here so determinism contracts hold even
    // if a caller bypasses the public API.
    double raw = seed.As<Napi::Number>().DoubleValue();
    if (!std::isfinite(raw) || raw < 0.0 || raw > 4294967295.0 ||
        raw != std::floor(raw)) {
      Napi::RangeError::New(env, "seed must be an integer in [0, 2^32)")
          .ThrowAsJavaScriptException();
      return false;
    }
    job.has_seed = true;
    job.seed = static_cast<uint32_t>(raw);
  }
  Napi::Value dir = obj.Get("directed");
  if (dir.IsBoolean()) {
    job.directed = dir.As<Napi::Boolean>().Value();
  }
  return true;
}

// Returns true on success, false on validation failure (in which case a JS
// exception is already pending and the caller should return Undefined()).
bool ReadEdgeListJob(Napi::Env env, Napi::Object input, LeidenJob& job) {
  if (!ReadNodeCount(env, input, job.node_count)) return false;

  Napi::Value sv = input.Get("sources");
  Napi::Value tv = input.Get("targets");
  if (!IsExactlyUint32Array(sv) || !IsExactlyUint32Array(tv)) {
    Napi::TypeError::New(env, "sources and targets must be Uint32Array")
        .ThrowAsJavaScriptException();
    return false;
  }
  Napi::Uint32Array sources = sv.As<Napi::Uint32Array>();
  Napi::Uint32Array targets = tv.As<Napi::Uint32Array>();
  if (sources.ElementLength() != targets.ElementLength()) {
    Napi::RangeError::New(env, "sources and targets must have equal length")
        .ThrowAsJavaScriptException();
    return false;
  }
  const size_t edge_count = sources.ElementLength();
  job.sources.assign(sources.Data(), sources.Data() + edge_count);
  job.targets.assign(targets.Data(), targets.Data() + edge_count);

  Napi::Value wv = input.Get("weights");
  if (!wv.IsUndefined() && !wv.IsNull()) {
    if (!IsExactlyFloat64Array(wv)) {
      Napi::TypeError::New(env, "weights must be a Float64Array").ThrowAsJavaScriptException();
      return false;
    }
    Napi::Float64Array weights = wv.As<Napi::Float64Array>();
    if (weights.ElementLength() != edge_count) {
      Napi::RangeError::New(env, "weights length must match edge count")
          .ThrowAsJavaScriptException();
      return false;
    }
    if (!ValidateWeights(env, weights.Data(), edge_count)) return false;
    job.weights.assign(weights.Data(), weights.Data() + edge_count);
    job.has_weights = true;
  }

  return ApplyOptions(env, input, job);
}

bool ReadCsrJob(Napi::Env env, Napi::Object input, LeidenJob& job) {
  if (!ReadNodeCount(env, input, job.node_count)) return false;

  Napi::Value ov = input.Get("offsets");
  Napi::Value tv = input.Get("targets");
  if (!IsExactlyUint32Array(ov) || !IsExactlyUint32Array(tv)) {
    Napi::TypeError::New(env, "offsets and targets must be Uint32Array")
        .ThrowAsJavaScriptException();
    return false;
  }
  Napi::Uint32Array offsets = ov.As<Napi::Uint32Array>();
  Napi::Uint32Array targets = tv.As<Napi::Uint32Array>();

  if (offsets.ElementLength() != static_cast<size_t>(job.node_count) + 1) {
    Napi::RangeError::New(env, "offsets length must be nodeCount + 1")
        .ThrowAsJavaScriptException();
    return false;
  }
  const uint32_t* offsets_data = offsets.Data();
  if (job.node_count > 0 && offsets_data[0] != 0) {
    Napi::RangeError::New(env, "offsets[0] must be 0").ThrowAsJavaScriptException();
    return false;
  }
  const uint32_t edge_count = offsets_data[job.node_count];
  if (targets.ElementLength() != edge_count) {
    Napi::RangeError::New(env, "targets length must match offsets[-1]")
        .ThrowAsJavaScriptException();
    return false;
  }
  // Defence in depth: the TS layer already enforces monotonicity, but a caller
  // that bypasses the public API (e.g. directly via the native addon) must
  // still not be able to drive us into an out-of-bounds write below.
  for (uint32_t v = 0; v < job.node_count; ++v) {
    if (offsets_data[v + 1] < offsets_data[v]) {
      Napi::RangeError::New(env, "offsets must be non-decreasing")
          .ThrowAsJavaScriptException();
      return false;
    }
    if (offsets_data[v + 1] > edge_count) {
      Napi::RangeError::New(env, "offsets values must not exceed offsets[-1]")
          .ThrowAsJavaScriptException();
      return false;
    }
  }

  job.targets.assign(targets.Data(), targets.Data() + edge_count);
  job.sources.resize(edge_count);
  for (uint32_t v = 0; v < job.node_count; ++v) {
    const uint32_t start = offsets_data[v];
    const uint32_t end = offsets_data[v + 1];
    for (uint32_t e = start; e < end; ++e) {
      job.sources[e] = v;
    }
  }

  Napi::Value wv = input.Get("weights");
  if (!wv.IsUndefined() && !wv.IsNull()) {
    if (!IsExactlyFloat64Array(wv)) {
      Napi::TypeError::New(env, "weights must be a Float64Array").ThrowAsJavaScriptException();
      return false;
    }
    Napi::Float64Array weights = wv.As<Napi::Float64Array>();
    if (weights.ElementLength() != edge_count) {
      Napi::RangeError::New(env, "weights length must match edge count")
          .ThrowAsJavaScriptException();
      return false;
    }
    if (!ValidateWeights(env, weights.Data(), edge_count)) return false;
    job.weights.assign(weights.Data(), weights.Data() + edge_count);
    job.has_weights = true;
  }

  return ApplyOptions(env, input, job);
}

Napi::Object BuildResultObject(Napi::Env env, const LeidenResultC& result) {
  Napi::Object out = Napi::Object::New(env);

  const size_t n = result.membership.size();
  Napi::Uint32Array membership = Napi::Uint32Array::New(env, n);
  uint32_t* data = membership.Data();
  for (size_t i = 0; i < n; ++i) {
    data[i] = static_cast<uint32_t>(result.membership[i]);
  }

  out.Set("membership", membership);
  out.Set("quality", Napi::Number::New(env, result.quality));
  out.Set("iterations", Napi::Number::New(env, static_cast<double>(result.iterations)));
  return out;
}

// ---------------------------------------------------------------------------
// AsyncWorker for the non-blocking variants.

class LeidenAsyncWorker : public Napi::AsyncWorker {
 public:
  LeidenAsyncWorker(Napi::Env env,
                    Napi::Promise::Deferred deferred,
                    LeidenJob&& job)
      : Napi::AsyncWorker(env), deferred_(deferred), job_(std::move(job)) {}

  void Execute() override {
    try {
      result_ = RunLeidenJob(job_);
    } catch (const std::exception& e) {
      SetError(e.what());
    } catch (...) {
      SetError("unknown C++ exception in Leiden worker");
    }
  }

  void OnOK() override {
    Napi::HandleScope scope(Env());
    deferred_.Resolve(BuildResultObject(Env(), result_));
  }

  void OnError(const Napi::Error& e) override {
    Napi::HandleScope scope(Env());
    deferred_.Reject(e.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  LeidenJob job_;
  LeidenResultC result_;
};

// ---------------------------------------------------------------------------
// JS entry points.

Napi::Value Version(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), kAddonVersion);
}

Napi::Value LeidenFromEdgeList(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "expected an options object").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Object input = info[0].As<Napi::Object>();
  LeidenJob job;
  if (!ReadEdgeListJob(env, input, job)) return env.Undefined();
  try {
    return BuildResultObject(env, RunLeidenJob(job));
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

Napi::Value LeidenFromCsrJs(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "expected an options object").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Object input = info[0].As<Napi::Object>();
  LeidenJob job;
  if (!ReadCsrJob(env, input, job)) return env.Undefined();
  try {
    return BuildResultObject(env, RunLeidenJob(job));
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

Napi::Value LeidenFromEdgeListAsync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto deferred = Napi::Promise::Deferred::New(env);
  if (info.Length() < 1 || !info[0].IsObject()) {
    deferred.Reject(Napi::TypeError::New(env, "expected an options object").Value());
    return deferred.Promise();
  }
  Napi::Object input = info[0].As<Napi::Object>();
  LeidenJob job;
  if (!ReadEdgeListJob(env, input, job)) {
    // ReadEdgeListJob threw a JS exception synchronously; convert that into a
    // promise rejection so callers get consistent error-handling semantics.
    Napi::Error pending = env.GetAndClearPendingException();
    deferred.Reject(pending.Value());
    return deferred.Promise();
  }
  auto* worker = new LeidenAsyncWorker(env, deferred, std::move(job));
  worker->Queue();
  return deferred.Promise();
}

Napi::Value LeidenFromCsrAsync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto deferred = Napi::Promise::Deferred::New(env);
  if (info.Length() < 1 || !info[0].IsObject()) {
    deferred.Reject(Napi::TypeError::New(env, "expected an options object").Value());
    return deferred.Promise();
  }
  Napi::Object input = info[0].As<Napi::Object>();
  LeidenJob job;
  if (!ReadCsrJob(env, input, job)) {
    Napi::Error pending = env.GetAndClearPendingException();
    deferred.Reject(pending.Value());
    return deferred.Promise();
  }
  auto* worker = new LeidenAsyncWorker(env, deferred, std::move(job));
  worker->Queue();
  return deferred.Promise();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("version", Napi::Function::New(env, Version));
  exports.Set("leidenFromEdgeList", Napi::Function::New(env, LeidenFromEdgeList));
  exports.Set("leidenFromCsr", Napi::Function::New(env, LeidenFromCsrJs));
  exports.Set("leidenFromEdgeListAsync",
              Napi::Function::New(env, LeidenFromEdgeListAsync));
  exports.Set("leidenFromCsrAsync", Napi::Function::New(env, LeidenFromCsrAsync));
  return exports;
}

}  // namespace

NODE_API_MODULE(fast_leiden, Init)
