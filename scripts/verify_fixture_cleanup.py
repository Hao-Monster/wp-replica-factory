#!/usr/bin/env python3
"""Verify owned WooCommerce fixture cleanup without trusting cleanup output."""

import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
MARKER = "replica-fixture"
FIXTURE_SKUS = [f"replica-fixture-{number:03d}" for number in range(1, 5)]


def load_adapter(config_path):
    path = ROOT / "adapters/wordpress-staging/adapter.py"
    spec = importlib.util.spec_from_file_location("cleanup_verifier_adapter", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module.StagingAdapter(json.loads(Path(config_path).read_text(encoding="utf-8")))


def _read_json(path, label):
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"invalid evidence: {label}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"invalid evidence: {label} must be an object")
    return value


def exact_marker_ids(candidates, marker=MARKER):
    """Return only objects whose API-read marker exactly matches this fixture."""
    return [int(row["id"]) for row in candidates if str(row.get("marker", "")) == marker]


def collect_snapshot(adapter, fixture_product_ids, fixture_order_ids, sentinel_product_id, sentinel_order_id):
    inputs = json.dumps({
        "marker": MARKER,
        "fixture_product_ids": [int(value) for value in fixture_product_ids],
        "fixture_order_ids": [int(value) for value in fixture_order_ids],
        "sentinel_product_id": int(sentinel_product_id),
        "sentinel_order_id": int(sentinel_order_id),
    })
    encoded = base64.b64encode(inputs.encode("utf-8")).decode("ascii")
    code = f"""
    $in=json_decode(base64_decode('{encoded}'),true);
    $marker=$in['marker'];
    $product_query=new WP_Query(['post_type'=>'product','post_status'=>'any','posts_per_page'=>-1,'fields'=>'ids']);
    if(is_wp_error($product_query)){{throw new Exception('product inventory query failed');}}
    $marked_products=[];
    foreach($product_query->posts as $id){{if((string)get_post_meta($id,'_replica_fixture_marker',true)===(string)$marker){{$marked_products[]=(int)$id;}}}}
    $statuses=array_keys(wc_get_order_statuses());
    $orders=wc_get_orders(['limit'=>-1,'type'=>'shop_order','status'=>$statuses,'return'=>'objects']);
    if(!is_array($orders)){{throw new Exception('order inventory query failed');}}
    $order_candidates=[];
    foreach($orders as $order){{if(!($order instanceof WC_Order)){{throw new Exception('order inventory object unreadable');}}$order_candidates[]=['id'=>(int)$order->get_id(),'marker'=>(string)$order->get_meta('_replica_fixture_marker')];}}
    $known_products=[]; foreach($in['fixture_product_ids'] as $id){{$known_products[(string)$id]=(bool)wc_get_product($id);}}
    $known_orders=[]; foreach($in['fixture_order_ids'] as $id){{$known_orders[(string)$id]=(bool)wc_get_order($id);}}
    $sp=wc_get_product($in['sentinel_product_id']); $so=wc_get_order($in['sentinel_order_id']);
    $sentinel_product=$sp?['id'=>(int)$sp->get_id(),'sku'=>(string)$sp->get_sku(),'price'=>(string)$sp->get_regular_price(),'status'=>(string)$sp->get_status()]:null;
    $items=[]; if($so){{foreach($so->get_items() as $item){{$items[]=['product_id'=>(int)$item->get_product_id(),'quantity'=>(int)$item->get_quantity()];}}}}
    $sentinel_order=$so?['id'=>(int)$so->get_id(),'status'=>(string)$so->get_status(),'total'=>(string)$so->get_total(),'items'=>$items]:null;
    $hpos=class_exists('Automattic\\WooCommerce\\Utilities\\OrderUtil') && Automattic\\WooCommerce\\Utilities\\OrderUtil::custom_orders_table_usage_is_enabled();
    echo wp_json_encode(['woocommerce_version'=>(string)WC_VERSION,'order_storage_backend'=>$hpos?'hpos':'legacy','marked_product_ids'=>$marked_products,'order_candidates'=>$order_candidates,'known_fixture_products'=>$known_products,'known_fixture_orders'=>$known_orders,'sentinel_product'=>$sentinel_product,'sentinel_order'=>$sentinel_order]);
    """
    try:
        result = json.loads(adapter.run_wp_cli(["eval", code]))
    except Exception as exc:
        raise RuntimeError(f"verification failure: unable to read WooCommerce objects: {exc}") from exc
    if not isinstance(result, dict) or not result.get("woocommerce_version") or result.get("order_storage_backend") not in {"hpos", "legacy"}:
        raise RuntimeError("verification failure: incomplete WooCommerce inventory")
    if not isinstance(result.get("order_candidates"), list):
        raise RuntimeError("verification failure: missing WooCommerce order candidates")
    result["marked_order_ids"] = exact_marker_ids(result.pop("order_candidates"))
    return result


def assess_cleanup(evidence, snapshot):
    reasons = []
    fixture_product_ids = [str(value) for value in evidence.get("fixture_product_ids", [])]
    fixture_order_ids = [str(value) for value in evidence.get("fixture_order_ids", [])]
    if snapshot.get("marked_product_ids"):
        reasons.append(f"fixture products remain: {snapshot['marked_product_ids']}")
    if snapshot.get("marked_order_ids"):
        reasons.append(f"fixture orders remain: {snapshot['marked_order_ids']}")
    existing_products = [value for value in fixture_product_ids if snapshot.get("known_fixture_products", {}).get(value)]
    existing_orders = [value for value in fixture_order_ids if snapshot.get("known_fixture_orders", {}).get(value)]
    if existing_products:
        reasons.append(f"created fixture product IDs still exist: {existing_products}")
    if existing_orders:
        reasons.append(f"created fixture order IDs still exist: {existing_orders}")
    for key in ("sentinel_product", "sentinel_order"):
        if snapshot.get(key) is None:
            reasons.append(f"{key} missing")
        elif snapshot[key] != evidence.get(key):
            reasons.append(f"{key} changed")
    return reasons


def build_report(evidence, snapshot):
    reasons = assess_cleanup(evidence, snapshot)
    return {
        "status": "fail" if reasons else "pass",
        "run_id": os.environ.get("GITHUB_RUN_ID", "local"),
        "source_sha": os.environ.get("GITHUB_SHA", "local"),
        "woocommerce_version": snapshot["woocommerce_version"],
        "order_storage_backend": snapshot["order_storage_backend"],
        "fixture_products": len(snapshot["marked_product_ids"]),
        "fixture_orders": len(snapshot["marked_order_ids"]),
        "remaining_product_ids": snapshot["marked_product_ids"],
        "remaining_order_ids": snapshot["marked_order_ids"],
        "expected_created_ids": {
            "products": snapshot["known_fixture_products"],
            "orders": snapshot["known_fixture_orders"],
        },
        "sentinel_product_exists": snapshot["sentinel_product"] is not None,
        "sentinel_order_exists": snapshot["sentinel_order"] is not None,
        "sentinel_product_unchanged": snapshot["sentinel_product"] == evidence.get("sentinel_product"),
        "sentinel_order_unchanged": snapshot["sentinel_order"] == evidence.get("sentinel_order"),
        "failure_reasons": reasons,
        "verifier_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("capture", "verify"))
    parser.add_argument("--config", required=True)
    parser.add_argument("--sentinel", required=True)
    parser.add_argument("--order", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--evidence")
    args = parser.parse_args()
    try:
        sentinel = _read_json(args.sentinel, "sentinel")
        order = _read_json(args.order, "order")
        order_id = int(order["order_id"])
        adapter = load_adapter(args.config)
        if args.command == "capture":
            seed = collect_snapshot(adapter, [], [order_id], sentinel["sentinel_product_id"], sentinel["sentinel_order_id"])
            product_ids = []
            for sku in FIXTURE_SKUS:
                raw = adapter.run_wp_cli(["eval", f"echo (string)wc_get_product_id_by_sku({json.dumps(sku)});"])
                if not raw.strip().isdigit():
                    raise ValueError(f"invalid evidence: fixture product missing for {sku}")
                product_ids.append(int(raw.strip()))
            seed["fixture_product_ids"] = product_ids
            seed["fixture_order_ids"] = [order_id]
            Path(args.output).write_text(json.dumps(seed, indent=2) + "\n", encoding="utf-8")
            print(json.dumps({"status": "captured", "woocommerce_version": seed["woocommerce_version"], "order_storage_backend": seed["order_storage_backend"]}))
            return 0
        evidence = _read_json(args.evidence, "ownership evidence")
        snapshot = collect_snapshot(adapter, evidence["fixture_product_ids"], evidence["fixture_order_ids"], sentinel["sentinel_product_id"], sentinel["sentinel_order_id"])
        report = build_report(evidence, snapshot)
        Path(args.output).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report))
        return 0 if report["status"] == "pass" else 1
    except Exception as exc:
        report = {"status": "fail", "failure_reasons": [str(exc)], "run_id": os.environ.get("GITHUB_RUN_ID", "local"), "source_sha": os.environ.get("GITHUB_SHA", "local")}
        Path(args.output).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
