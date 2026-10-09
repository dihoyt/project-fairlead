#!/usr/bin/env python3
# A stand-in for kubectl over a JSON state file, covering exactly the calls
# the convert script makes, with the PersistentVolume binding rules that
# matter to it: a deleted claim releases its volume, Delete removes a
# released volume, a volume with a claimRef can't be bound again.
import json
import os
import sys

STATE = os.environ["FAKE_STATE"]


def load():
    with open(STATE) as f:
        return json.load(f)


def save(state):
    with open(STATE, "w") as f:
        json.dump(state, f)


def fail(message):
    print(f"Error from server: {message}", file=sys.stderr)
    sys.exit(1)


def pods(state):
    out = []
    for workload, replicas in state["workloads"].items():
        for i in range(replicas):
            out.append({"metadata": {"name": f"{workload.split('/')[1]}-{i}"},
                        "spec": {"volumes": [{"persistentVolumeClaim": {"claimName": c}}
                                             for c in state["mounts"].get(workload, [])]}})
    for job in state["jobs"].values():
        if job.get("running"):
            out.append({"metadata": {"name": "job"}, "spec": {"volumes": job["volumes"]}})
    return out


def release(state, pv_name):
    pv = state["pvs"][pv_name]
    pv["phase"] = "Released"
    if pv["policy"] == "Delete":
        del state["pvs"][pv_name]


def bind(state, claim, obj):
    spec = obj["spec"]
    volume = spec.get("volumeName")
    if volume:
        pv = state["pvs"].get(volume)
        if not pv or pv.get("claimRef"):
            fail(f"volume {volume} is not available")
    else:
        state["seq"] += 1
        volume = f"pv-{spec['storageClassName']}-{state['seq']}"
        state["pvs"][volume] = {"policy": "Delete", "class": spec["storageClassName"]}
    state["pvs"][volume].update({"claimRef": claim, "phase": "Bound"})
    state["pvcs"][claim] = {"volumeName": volume, "class": spec["storageClassName"]}


def main(argv):
    state = load()
    state["calls"].append(" ".join(argv))
    args = list(argv)
    if "-n" in args:
        i = args.index("-n")
        del args[i:i + 2]
    flags = {a.split("=", 1)[0]: (a.split("=", 1)[1] if "=" in a else True) for a in args if a.startswith("-")}
    words = [a for a in args if not a.startswith("-")]
    # Values of flags given as separate words.
    for flag in ("-o", "-p", "--type", "-l", "-f"):
        if flag in args:
            value = args[args.index(flag) + 1]
            flags[flag] = value
            words.remove(value)
    verb = words[0]

    if verb == "scale":
        workload = words[1]
        state["workloads"][workload] = int(flags["--replicas"])
        for claim in state["mounts"].get(workload, []) if state["workloads"][workload] else []:
            if claim not in state["pvcs"]:
                fail(f"pod can't start: claim {claim} not found")
    elif verb == "rollout":
        if state.get("failRollout"):
            fail("rollout did not finish")
    elif verb == "logs":
        print("Copied 3 files and directories (12K).")
    elif verb == "create":
        with open(flags["-f"]) as f:
            obj = json.load(f)
        name = obj["metadata"]["name"]
        if obj["kind"] == "Volume":
            ok = not state.get("failRestore")
            state.setdefault("lhvolumes", {})[name] = {
                "restoreInitiated": True, "restoreRequired": not ok, "state": "detached" if ok else "faulted"}
        elif obj["kind"] == "PersistentVolume":
            spec = obj["spec"]
            state["pvs"][name] = {"policy": spec["persistentVolumeReclaimPolicy"], "class": spec["storageClassName"],
                                  "phase": "Available"}
        elif obj["kind"] == "PersistentVolumeClaim":
            if name in state["pvcs"]:
                fail(f"persistentvolumeclaims {name} already exists")
            bind(state, name, obj)
        elif obj["kind"] == "Job":
            volumes = obj["spec"]["template"]["spec"]["volumes"]
            ok = name not in state.get("failJobs", [])
            state["jobs"][name] = {"status": "1/" if ok else "/1", "volumes": volumes, "running": False}
            if ok:
                to = next(v["persistentVolumeClaim"]["claimName"] for v in volumes if v["name"] == "to")
                frm = next(v["persistentVolumeClaim"]["claimName"] for v in volumes if v["name"] == "from")
                state["data"][state["pvcs"][to]["volumeName"]] = state["data"].get(state["pvcs"][frm]["volumeName"])
    elif verb == "delete":
        kind = words[1]
        if kind == "pv":
            state["pvs"].pop(words[2], None)
        elif kind == "volumes.longhorn.io":
            state.get("lhvolumes", {}).pop(words[2], None)
        elif kind == "job":
            if "-l" not in flags:
                state["jobs"].pop(words[2], None)
        elif kind == "pvc":
            name = words[2]
            if name not in state["pvcs"]:
                if "--ignore-not-found" in flags:
                    return save(state)
                fail(f"persistentvolumeclaims {name} not found")
            if any(v.get("persistentVolumeClaim", {}).get("claimName") == name
                   for p in pods(state) for v in p["spec"]["volumes"]):
                fail(f"claim {name} is in use (the real one would hang)")
            pv = state["pvcs"].pop(name)["volumeName"]
            release(state, pv)
    elif verb == "get":
        kind, name = words[1], (words[2] if len(words) > 2 else None)
        out = flags.get("-o", "")
        if kind == "pods":
            print(json.dumps({"items": pods(state)}))
        elif kind == "volumes.longhorn.io":
            print(json.dumps({"status": state.get("lhvolumes", {})[name]}))
        elif kind == "job":
            print(state["jobs"][name]["status"])
        elif kind == "pvc":
            if name not in state["pvcs"]:
                fail(f"persistentvolumeclaims {name} not found")
            pvc = state["pvcs"][name]
            print(pvc["volumeName"] if "volumeName" in out else "Bound", end="")
        elif kind == "pv":
            if name not in state["pvs"]:
                fail(f"persistentvolumes {name} not found")
            if "Policy" in out:
                print(state["pvs"][name]["policy"], end="")
        else:
            fail(f"fake kubectl can't get {kind}")
    elif verb == "patch":
        name = words[2]
        if name not in state["pvs"]:
            fail(f"persistentvolumes {name} not found")
        pv = state["pvs"][name]
        if flags.get("--type") == "json":
            pv["claimRef"] = None
            pv["phase"] = "Available"
        else:
            pv["policy"] = json.loads(flags["-p"])["spec"]["persistentVolumeReclaimPolicy"]
            if pv["policy"] == "Delete" and pv.get("phase") == "Released":
                del state["pvs"][name]
    else:
        fail(f"fake kubectl can't {verb}")
    save(state)


if __name__ == "__main__":
    main(sys.argv[1:])
