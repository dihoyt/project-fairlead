#!/usr/bin/env python3
# A stand-in for kubectl covering the calls the node drain and reboot
# scripts make, over a JSON state file: the node's cordon flag, boot ID and
# readiness, the reboot pod, and the PodDisruptionBudgets listed on failure.
# A created reboot pod takes the node down on the next read and back up
# with a new boot ID on the one after, unless the state says it fails.
import json
import os
import sys

STATE = os.environ["FAKE_STATE"]

with open(STATE) as f:
    state = json.load(f)


def save():
    with open(STATE, "w") as f:
        json.dump(state, f)


args = sys.argv[1:]
state["calls"].append(" ".join(args))
verb = args[0]

if verb == "drain":
    if state.get("drainFails"):
        print('error when evicting pods/"db-0" -n "apps": Cannot evict pod as it would violate the pod\'s disruption budget.', file=sys.stderr)
        print("error: unable to drain node, timed out", file=sys.stderr)
        state["unschedulable"] = True
        save()
        sys.exit(1)
    state["unschedulable"] = True
    print(f"node/{args[1]} cordoned")
    print("evicting pod apps/web-1")
    print("pod/web-1 evicted")
    print(f"node/{args[1]} drained")
elif verb == "uncordon":
    state["unschedulable"] = False
    print(f"node/{args[1]} uncordoned")
elif verb == "get" and args[1] == "poddisruptionbudgets":
    print(json.dumps({"items": state.get("pdbs", [])}))
elif verb == "get" and args[1] == "node":
    path = args[-1]
    if "unschedulable" in path:
        print("true" if state["unschedulable"] else "", end="")
    elif "conditions" in path:
        phase = state.get("rebootPhase")
        if phase == "going-down":
            state["rebootPhase"] = "coming-up"
            print(f"{state['bootID']} False", end="")
        elif phase == "coming-up":
            state["rebootPhase"] = "done"
            state["bootID"] = state["bootID"] + "-2"
            print(f"{state['bootID']} True", end="")
        else:
            print(f"{state['bootID']} True", end="")
    else:
        print(state["bootID"], end="")
elif verb == "get" and args[1] == "pod":
    print("Failed" if state.get("rebootFails") else "Running", end="")
elif verb == "create":
    with open(args[-1]) as f:
        state["created"] = json.load(f)
    if not state.get("rebootFails") and not state.get("neverReturns"):
        state["rebootPhase"] = "going-down"
    print(f"pod/{state['created']['metadata']['name']} created")
elif verb == "delete":
    print("deleted")
elif verb == "logs":
    print("Failed to connect to bus")
else:
    print(f"unexpected kubectl {' '.join(args)}", file=sys.stderr)
    sys.exit(2)
save()
