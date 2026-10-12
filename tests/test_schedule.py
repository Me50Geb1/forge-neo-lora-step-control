# Dependency-free truth-table checks for packaging QA.


def active(start, stop, step):
    return (start is None or step >= start) and (stop is None or step < stop)


def test_start():
    assert not active(10, None, 9)
    assert active(10, None, 10)


def test_stop():
    assert active(None, 10, 9)
    assert not active(None, 10, 10)


def test_range():
    assert not active(5, 10, 4)
    assert active(5, 10, 5)
    assert active(5, 10, 9)
    assert not active(5, 10, 10)
