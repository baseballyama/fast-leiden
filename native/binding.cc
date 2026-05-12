// fast-leiden — native binding.
//
// Exposes three N-API functions:
//
//   - version():              addon version string (smoke test)
//   - leidenFromEdgeList():   run Leiden given source/target arrays
//   - leidenFromCsr():        run Leiden given a CSR-encoded graph
//
// Both leiden* functions accept an options object on the JS side and return
// an object { membership: Uint32Array, quality: number, iterations: number }.

#include <napi.h>

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include <igraph/igraph.h>
#include <CPMVertexPartition.h>
#include <GraphHelper.h>
#include <ModularityVertexPartition.h>
#include <Optimiser.h>

namespace {

constexpr const char* kAddonVersion = "0.1.0";

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
// Options shared by both entry points.

struct LeidenCallOptions {
  std::string quality_function = "modularity";
  double resolution = 1.0;
  int max_iterations = 10;
  bool has_seed = false;
  uint32_t seed = 0;
  bool directed = false;
};

LeidenCallOptions ReadOptions(const Napi::Object& obj) {
  // The TS wrapper passes every option key through, even when the caller
  // left it undefined. Guarding on IsString/IsNumber/IsBoolean keeps the
  // C++ side robust regardless of how the JS object was constructed.
  LeidenCallOptions opts;
  Napi::Value q = obj.Get("qualityFunction");
  if (q.IsString()) {
    opts.quality_function = q.As<Napi::String>().Utf8Value();
  }
  Napi::Value res = obj.Get("resolution");
  if (res.IsNumber()) {
    opts.resolution = res.As<Napi::Number>().DoubleValue();
  }
  Napi::Value mi = obj.Get("maxIterations");
  if (mi.IsNumber()) {
    opts.max_iterations = mi.As<Napi::Number>().Int32Value();
  }
  Napi::Value seed = obj.Get("seed");
  if (seed.IsNumber()) {
    opts.has_seed = true;
    opts.seed = seed.As<Napi::Number>().Uint32Value();
  }
  Napi::Value dir = obj.Get("directed");
  if (dir.IsBoolean()) {
    opts.directed = dir.As<Napi::Boolean>().Value();
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Build an `igraph_t` from raw edge arrays. Returns an owning IgraphGuard via
// the out parameter `g`. The caller is responsible for the guard's lifetime.

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

// ---------------------------------------------------------------------------
// Run Leiden on a graph that has already been wrapped by the leidenalg
// `Graph` helper. The partition is created based on `opts.quality_function`.
// Returns membership, final quality, and the number of outer-loop iterations
// the optimiser actually performed (it converges before max_iterations when
// no further improvement is possible).

struct LeidenResultC {
  std::vector<size_t> membership;
  double quality;
  int iterations;
};

LeidenResultC RunLeiden(Graph& graph, const LeidenCallOptions& opts) {
  std::unique_ptr<MutableVertexPartition> partition;
  if (opts.quality_function == "modularity") {
    partition.reset(new ModularityVertexPartition(&graph));
  } else if (opts.quality_function == "cpm") {
    partition.reset(new CPMVertexPartition(&graph, opts.resolution));
  } else {
    throw std::runtime_error("unknown qualityFunction: " + opts.quality_function);
  }

  Optimiser optimiser;
  if (opts.has_seed) {
    optimiser.set_rng_seed(static_cast<size_t>(opts.seed));
  }

  // The Leiden algorithm in libleidenalg is itself iterative inside one
  // optimise_partition() call; the outer loop here mirrors leidenalg's
  // Python `n_iterations` parameter — re-running optimise_partition often
  // squeezes out another improvement, until it returns 0 (converged).
  int iterations_run = 0;
  for (int i = 0; i < opts.max_iterations; ++i) {
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

  if (!input.Has("nodeCount") || !input.Get("nodeCount").IsNumber()) {
    Napi::TypeError::New(env, "nodeCount must be a number").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const uint32_t node_count = input.Get("nodeCount").As<Napi::Number>().Uint32Value();

  if (!input.Has("sources") || !input.Get("sources").IsTypedArray()) {
    Napi::TypeError::New(env, "sources must be a Uint32Array").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Uint32Array sources = input.Get("sources").As<Napi::Uint32Array>();

  if (!input.Has("targets") || !input.Get("targets").IsTypedArray()) {
    Napi::TypeError::New(env, "targets must be a Uint32Array").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Uint32Array targets = input.Get("targets").As<Napi::Uint32Array>();

  if (sources.ElementLength() != targets.ElementLength()) {
    Napi::RangeError::New(env, "sources and targets must have equal length")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const size_t edge_count = sources.ElementLength();

  std::vector<double> edge_weights;
  bool has_weights = false;
  if (input.Has("weights") && !input.Get("weights").IsUndefined()) {
    Napi::Value w = input.Get("weights");
    if (!w.IsTypedArray()) {
      Napi::TypeError::New(env, "weights must be a Float64Array").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    Napi::Float64Array weights = w.As<Napi::Float64Array>();
    if (weights.ElementLength() != edge_count) {
      Napi::RangeError::New(env, "weights length must match edge count")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    edge_weights.assign(weights.Data(), weights.Data() + edge_count);
    has_weights = true;
  }

  LeidenCallOptions opts = ReadOptions(input);

  try {
    igraph_t g;
    BuildIgraphFromEdges(&g, node_count, sources.Data(), targets.Data(), edge_count,
                         opts.directed);
    IgraphGuard g_guard(&g);

    std::unique_ptr<Graph> graph(
        has_weights ? Graph::GraphFromEdgeWeights(&g, edge_weights) : new Graph(&g));
    LeidenResultC result = RunLeiden(*graph, opts);
    return BuildResultObject(env, result);
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

  const uint32_t node_count = input.Get("nodeCount").As<Napi::Number>().Uint32Value();
  Napi::Uint32Array offsets = input.Get("offsets").As<Napi::Uint32Array>();
  Napi::Uint32Array targets = input.Get("targets").As<Napi::Uint32Array>();

  if (offsets.ElementLength() != static_cast<size_t>(node_count) + 1) {
    Napi::RangeError::New(env, "offsets length must be nodeCount + 1")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const uint32_t* offsets_data = offsets.Data();
  const uint32_t edge_count = offsets_data[node_count];
  if (targets.ElementLength() != edge_count) {
    Napi::RangeError::New(env, "targets length must match offsets[-1]")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const uint32_t* targets_data = targets.Data();

  std::vector<double> edge_weights;
  bool has_weights = false;
  if (input.Has("weights") && !input.Get("weights").IsUndefined()) {
    Napi::Float64Array weights = input.Get("weights").As<Napi::Float64Array>();
    if (weights.ElementLength() != edge_count) {
      Napi::RangeError::New(env, "weights length must match edge count")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    edge_weights.assign(weights.Data(), weights.Data() + edge_count);
    has_weights = true;
  }

  // Expand CSR -> flat source array, then reuse the edge-list path. This
  // costs one extra allocation but keeps the C++ code paths unified.
  std::vector<uint32_t> sources(edge_count);
  for (uint32_t v = 0; v < node_count; ++v) {
    const uint32_t start = offsets_data[v];
    const uint32_t end = offsets_data[v + 1];
    for (uint32_t e = start; e < end; ++e) {
      sources[e] = v;
    }
  }

  LeidenCallOptions opts = ReadOptions(input);

  try {
    igraph_t g;
    BuildIgraphFromEdges(&g, node_count, sources.data(), targets_data, edge_count,
                         opts.directed);
    IgraphGuard g_guard(&g);

    std::unique_ptr<Graph> graph(
        has_weights ? Graph::GraphFromEdgeWeights(&g, edge_weights) : new Graph(&g));
    LeidenResultC result = RunLeiden(*graph, opts);
    return BuildResultObject(env, result);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("version", Napi::Function::New(env, Version));
  exports.Set("leidenFromEdgeList", Napi::Function::New(env, LeidenFromEdgeList));
  exports.Set("leidenFromCsr", Napi::Function::New(env, LeidenFromCsrJs));
  return exports;
}

}  // namespace

NODE_API_MODULE(fast_leiden, Init)
